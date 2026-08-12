use crate::jarvis::agent_registry::{IdentityDecision, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT};
use crate::jarvis::tools::{
    attach_terminal_titles, list_terminals_for_workspace, JarvisState, JarvisToolService,
};
use crate::jarvis::types::{
    AgentActivityEvent, AgentMessage, AgentResult, AgentSessionContext, AgentSessionRef, AgentTail,
    ContextPackageV1, InvocationBinding, JarvisErrorEnvelope, ModelContextViewV1, RequestedDepth,
    TerminalSummary, ToolEnvelope, WorkspaceSummary,
};
use crate::terminal_engine::TerminalManager;
use crate::workspace::registry::{WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn jarvis_agent_open(
    app: AppHandle,
    invocation: InvocationBinding,
    provider: String,
    initial_prompt: Option<String>,
) -> Result<ToolEnvelope<crate::jarvis::control::AgentOpenResult>, JarvisErrorEnvelope> {
    let observed_at = now();
    if invocation.target_workspace_id.trim().is_empty() {
        return Err(JarvisErrorEnvelope::new(
            "workspace_required",
            "workspace is required",
            Some(invocation.request_id),
            None,
            observed_at,
        ));
    }
    let workspace = load_workspace(
        &app.state::<WorkspaceRegistry>(),
        &invocation.target_workspace_id,
        Some(invocation.request_id.clone()),
        &invocation.created_at,
    )
    .await?;
    let result = crate::jarvis::control::open_agent_for_invocation(
        &app,
        &workspace,
        &invocation,
        &provider,
        initial_prompt,
    )
    .await
    .map_err(|message| {
        JarvisErrorEnvelope::new(
            "agent_open_failed",
            message,
            Some(invocation.request_id.clone()),
            Some(invocation.target_workspace_id.clone()),
            &observed_at,
        )
    })?;
    Ok(ToolEnvelope {
        data: result,
        provenance: crate::jarvis::types::Provenance::trusted("agent-open", &observed_at),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn jarvis_workspace_list(
    app: AppHandle,
) -> Result<ToolEnvelope<Vec<WorkspaceSummary>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspaces = load_workspaces(&workspace_registry, None, None, &observed_at).await?;
    Ok(JarvisToolService::new(&app.state::<JarvisState>().broker)
        .workspace_list(&workspaces, &observed_at))
}

#[tauri::command]
pub async fn jarvis_terminal_list(
    app: AppHandle,
    workspace_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<Vec<TerminalSummary>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, &workspace, &observed_at).await;
    JarvisToolService::new(&app.state::<JarvisState>().broker).terminal_list(
        &workspace_id,
        terminals,
        &observed_at,
    )
}

#[tauri::command]
pub async fn jarvis_agent_list(
    app: AppHandle,
    workspace_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<Vec<AgentSessionRef>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    reconcile_live_registry(&app, &observed_at).await;
    let mut envelope = JarvisToolService::new(&app.state::<JarvisState>().broker).agent_list(
        &workspace_id,
        request_id,
        &observed_at,
    )?;
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, &workspace, &observed_at).await;
    for reference in &mut envelope.data {
        reference.terminal_title = reference.terminal_id.as_deref().and_then(|terminal_id| {
            terminals
                .iter()
                .find(|terminal| {
                    terminal.terminal_id == terminal_id
                        && terminal.generation == reference.generation
                })
                .map(|terminal| terminal.title.clone())
        });
    }
    Ok(envelope)
}

#[tauri::command]
pub async fn jarvis_agent_snapshot(
    app: AppHandle,
    workspace_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<Vec<AgentSessionContext>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    reconcile_live_registry(&app, &observed_at).await;
    let mut envelope = JarvisToolService::new(&app.state::<JarvisState>().broker).agent_snapshot(
        &workspace_id,
        request_id,
        &observed_at,
    )?;
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, &workspace, &observed_at).await;
    attach_terminal_titles(&mut envelope.data, &terminals);
    Ok(envelope)
}

#[tauri::command]
pub async fn jarvis_agent_get_status(
    app: AppHandle,
    workspace_id: String,
    agent_session_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<AgentSessionContext>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    reconcile_live_registry(&app, &observed_at).await;
    let mut envelope = JarvisToolService::new(&app.state::<JarvisState>().broker).agent_status(
        &workspace_id,
        &agent_session_id,
        request_id,
        &observed_at,
    )?;
    let terminals =
        list_terminals_for_workspace(&app.state::<TerminalManager>(), &workspace, &observed_at)
            .await;
    attach_terminal_titles(std::slice::from_mut(&mut envelope.data), &terminals);
    Ok(envelope)
}

#[tauri::command]
pub async fn jarvis_agent_get_last_result(
    app: AppHandle,
    workspace_id: String,
    agent_session_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<Option<AgentResult>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    JarvisToolService::new(&app.state::<JarvisState>().broker).agent_last_result(
        &workspace_id,
        &agent_session_id,
        request_id,
        &observed_at,
    )
}

#[tauri::command]
pub async fn jarvis_agent_get_messages(
    app: AppHandle,
    workspace_id: String,
    agent_session_id: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<Vec<AgentMessage>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    JarvisToolService::new(&app.state::<JarvisState>().broker).agent_messages(
        &workspace_id,
        &agent_session_id,
        request_id,
        &observed_at,
    )
}

#[tauri::command]
pub async fn jarvis_agent_activity(
    app: AppHandle,
    workspace_id: String,
    agent_session_id: String,
    request_id: Option<String>,
    limit: Option<u8>,
) -> Result<ToolEnvelope<Vec<AgentActivityEvent>>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    let limit = limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_ACTIVITY_LIMIT)
        .clamp(1, MAX_ACTIVITY_LIMIT);
    JarvisToolService::new(&app.state::<JarvisState>().broker).agent_activity(
        &workspace_id,
        &agent_session_id,
        limit,
        request_id,
        &observed_at,
    )
}

/// Read only the bounded tail of one live agent terminal. The terminal and
/// generation are revalidated here so a stale conversational plan cannot
/// read or act on a reused PTY identity.
#[tauri::command]
pub async fn jarvis_agent_tail(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    generation: u64,
    max_lines: Option<usize>,
    request_id: Option<String>,
) -> Result<ToolEnvelope<AgentTail>, JarvisErrorEnvelope> {
    let observed_at = now();
    let workspace_registry = app.state::<WorkspaceRegistry>();
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != workspace_id || snapshot.generation != generation {
        return Err(JarvisErrorEnvelope::new(
            "terminal_generation_mismatch",
            "terminal generation is no longer current",
            request_id,
            Some(workspace_id),
            &observed_at,
        ));
    }
    if !snapshot.is_agent_terminal {
        return Err(JarvisErrorEnvelope::new(
            "terminal_not_agent",
            "terminal is not a recognized agent session",
            request_id,
            Some(workspace_id),
            &observed_at,
        ));
    }
    let raw = app
        .state::<TerminalManager>()
        .get_recent_normalized_terminal_text_for_runtime(
            &terminal_id,
            &snapshot.workspace_id,
            snapshot.generation,
            snapshot.process_id,
            crate::jarvis::control::MAX_TAIL_BYTES,
        )
        .await
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "terminal_tail_unavailable",
                "terminal tail unavailable",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?;
    let tail = crate::jarvis::control::build_tail(
        &workspace_id,
        &terminal_id,
        generation,
        &raw.content,
        max_lines.unwrap_or(crate::jarvis::control::DEFAULT_TAIL_LINES),
        raw.truncated,
    );
    Ok(ToolEnvelope {
        data: tail,
        provenance: crate::jarvis::types::Provenance::untrusted("terminal-tail", &observed_at),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub fn jarvis_mark_selected_agent(
    app: AppHandle,
    workspace_id: String,
    agent_session_id: String,
    request_id: Option<String>,
) -> Result<(), JarvisErrorEnvelope> {
    let observed_at = now();
    let sessions = app
        .state::<JarvisState>()
        .registry
        .list_sessions(&workspace_id)
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "agent_registry_unavailable",
                "agent registry unavailable",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?;
    let session = sessions
        .into_iter()
        .find(|session| session.agent_session_id == agent_session_id)
        .ok_or_else(|| {
            JarvisErrorEnvelope::new(
                "agent_session_not_found",
                "agent session not found",
                request_id,
                Some(workspace_id),
                &observed_at,
            )
        })?;
    app.state::<JarvisState>().registry.mark_selected(&session);
    Ok(())
}

#[tauri::command]
pub async fn jarvis_confirm_identity(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    generation: u64,
    provider: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<AgentSessionRef>, JarvisErrorEnvelope> {
    decide_identity(
        &app,
        workspace_id,
        terminal_id,
        generation,
        provider,
        request_id,
        IdentityDecision::Confirmed,
    )
    .await
}

#[tauri::command]
pub async fn jarvis_ignore_identity(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    generation: u64,
    provider: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<AgentSessionRef>, JarvisErrorEnvelope> {
    decide_identity(
        &app,
        workspace_id,
        terminal_id,
        generation,
        provider,
        request_id,
        IdentityDecision::Ignored,
    )
    .await
}

#[tauri::command]
pub async fn jarvis_clear_identity_decision(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    generation: u64,
    provider: String,
    request_id: Option<String>,
) -> Result<ToolEnvelope<AgentSessionRef>, JarvisErrorEnvelope> {
    let observed_at = now();
    let manager = app.state::<TerminalManager>();
    let snapshot = manager
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != workspace_id || snapshot.generation != generation {
        return Err(JarvisErrorEnvelope::new(
            "terminal_generation_mismatch",
            "terminal generation is no longer current",
            request_id,
            Some(workspace_id),
            &observed_at,
        ));
    }
    app.state::<JarvisState>().registry.clear_identity_decision(
        &terminal_id,
        generation,
        &provider,
    );
    identity_session(
        &app,
        &workspace_id,
        &terminal_id,
        generation,
        &provider,
        request_id,
        &observed_at,
    )
}

async fn decide_identity(
    app: &AppHandle,
    workspace_id: String,
    terminal_id: String,
    generation: u64,
    provider: String,
    request_id: Option<String>,
    decision: IdentityDecision,
) -> Result<ToolEnvelope<AgentSessionRef>, JarvisErrorEnvelope> {
    let observed_at = now();
    let manager = app.state::<TerminalManager>();
    let snapshot = manager
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            JarvisErrorEnvelope::new(
                "terminal_not_found",
                "terminal not found",
                request_id.clone(),
                Some(workspace_id.clone()),
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != workspace_id || snapshot.generation != generation {
        return Err(JarvisErrorEnvelope::new(
            "terminal_generation_mismatch",
            "terminal generation is no longer current",
            request_id,
            Some(workspace_id),
            &observed_at,
        ));
    }
    app.state::<JarvisState>().registry.set_identity_decision(
        &terminal_id,
        generation,
        &provider,
        decision,
    );
    identity_session(
        app,
        &workspace_id,
        &terminal_id,
        generation,
        &provider,
        request_id,
        &observed_at,
    )
}

fn identity_session(
    app: &AppHandle,
    workspace_id: &str,
    terminal_id: &str,
    generation: u64,
    provider: &str,
    request_id: Option<String>,
    observed_at: &str,
) -> Result<ToolEnvelope<AgentSessionRef>, JarvisErrorEnvelope> {
    let session = app
        .state::<JarvisState>()
        .registry
        .list_sessions(workspace_id)
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "agent_registry_unavailable",
                "agent registry unavailable",
                request_id.clone(),
                Some(workspace_id.to_string()),
                observed_at,
            )
        })?
        .into_iter()
        .find(|session| {
            session.terminal_id.as_deref() == Some(terminal_id)
                && session.generation == generation
                && (session.resolved_provider == provider
                    || session.observed_provider.as_deref() == Some(provider))
        })
        .ok_or_else(|| {
            JarvisErrorEnvelope::new(
                "agent_session_not_found",
                "agent session not found",
                request_id.clone(),
                Some(workspace_id.to_string()),
                observed_at,
            )
        })?;
    Ok(ToolEnvelope {
        data: session,
        provenance: crate::jarvis::types::Provenance::trusted("agent-registry", observed_at),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn jarvis_build_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
) -> Result<ContextPackageV1, JarvisErrorEnvelope> {
    build_context(
        app,
        workspace_id,
        request_id,
        requested_depth,
        target_terminal_id,
        target_agent_session_id,
        false,
    )
    .await
}

#[tauri::command]
pub async fn jarvis_refresh_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
) -> Result<ContextPackageV1, JarvisErrorEnvelope> {
    build_context(
        app,
        workspace_id,
        request_id,
        requested_depth,
        target_terminal_id,
        target_agent_session_id,
        true,
    )
    .await
}

#[tauri::command]
pub async fn jarvis_build_model_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
    requested_document_paths: Vec<String>,
) -> Result<ModelContextViewV1, JarvisErrorEnvelope> {
    build_model_context(
        app,
        workspace_id,
        request_id,
        requested_depth,
        target_terminal_id,
        target_agent_session_id,
        requested_document_paths,
        false,
    )
    .await
}

#[tauri::command]
pub async fn jarvis_refresh_model_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
    requested_document_paths: Vec<String>,
) -> Result<ModelContextViewV1, JarvisErrorEnvelope> {
    build_model_context(
        app,
        workspace_id,
        request_id,
        requested_depth,
        target_terminal_id,
        target_agent_session_id,
        requested_document_paths,
        true,
    )
    .await
}

async fn build_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
    refresh: bool,
) -> Result<ContextPackageV1, JarvisErrorEnvelope> {
    let created_at = now();
    if request_id.trim().is_empty() || workspace_id.trim().is_empty() {
        return Err(JarvisErrorEnvelope::new(
            "invocation_invalid",
            "requestId and workspaceId are required",
            Some(request_id),
            Some(workspace_id),
            created_at,
        ));
    }
    let invocation = InvocationBinding::new(
        request_id.clone(),
        workspace_id.clone(),
        target_terminal_id.clone(),
        target_agent_session_id,
        created_at,
    );
    let workspace_registry = app.state::<WorkspaceRegistry>();
    let workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        Some(request_id.clone()),
        &invocation.created_at,
    )
    .await?;
    let manager = app.state::<TerminalManager>();
    let terminals =
        list_terminals_for_workspace(&manager, &workspace, &invocation.created_at).await;
    let all_agent_terminals = manager.list_agent_snapshots().await;
    app.state::<JarvisState>()
        .registry
        .reconcile(&all_agent_terminals, &invocation.created_at);
    if let Some(terminal_id) = target_terminal_id {
        let configured_terminal = workspace
            .terminals
            .iter()
            .any(|terminal| terminal.id == terminal_id);
        if !configured_terminal
            && !terminals
                .iter()
                .any(|terminal| terminal.terminal_id == terminal_id)
        {
            return Err(JarvisErrorEnvelope::new(
                "terminal_not_owned",
                "terminal does not belong to target workspace",
                Some(request_id),
                Some(workspace_id),
                invocation.created_at,
            ));
        }
    }
    let state = app.state::<JarvisState>();
    let service = JarvisToolService::new(&state.broker);
    if refresh {
        service.refresh_context(&workspace, invocation, terminals, requested_depth)
    } else {
        service.build_context(&workspace, invocation, terminals, requested_depth)
    }
}

pub(crate) async fn reconcile_live_registry(app: &AppHandle, observed_at: &str) {
    let manager = app.state::<TerminalManager>();
    let terminals = manager.list_agent_snapshots().await;
    app.state::<JarvisState>()
        .registry
        .reconcile(&terminals, observed_at);
}

async fn build_model_context(
    app: AppHandle,
    workspace_id: String,
    request_id: String,
    requested_depth: RequestedDepth,
    target_terminal_id: Option<String>,
    target_agent_session_id: Option<String>,
    requested_document_paths: Vec<String>,
    refresh: bool,
) -> Result<ModelContextViewV1, JarvisErrorEnvelope> {
    let package = build_context(
        app,
        workspace_id.clone(),
        request_id.clone(),
        requested_depth,
        target_terminal_id,
        target_agent_session_id,
        refresh,
    )
    .await?;
    package
        .to_model_context_view(&requested_document_paths)
        .map_err(|_| {
            JarvisErrorEnvelope::new(
                "document_path_invalid",
                "requested document path rejected by context policy",
                Some(request_id),
                Some(workspace_id),
                package.documentation.generated_at.clone(),
            )
        })
}

async fn load_workspace(
    registry: &WorkspaceRegistry,
    workspace_id: &str,
    request_id: Option<String>,
    observed_at: &str,
) -> Result<WorkspaceConfig, JarvisErrorEnvelope> {
    registry.load().await.map_err(|_| {
        JarvisErrorEnvelope::new(
            "workspace_registry_unavailable",
            "workspace registry unavailable",
            request_id.clone(),
            Some(workspace_id.to_string()),
            observed_at,
        )
    })?;
    registry.get(workspace_id).await.ok_or_else(|| {
        JarvisErrorEnvelope::new(
            "workspace_not_found",
            "workspace not found",
            request_id,
            Some(workspace_id.to_string()),
            observed_at,
        )
    })
}

async fn load_workspaces(
    registry: &WorkspaceRegistry,
    request_id: Option<String>,
    workspace_id: Option<String>,
    observed_at: &str,
) -> Result<Vec<WorkspaceConfig>, JarvisErrorEnvelope> {
    registry.load().await.map_err(|_| {
        JarvisErrorEnvelope::new(
            "workspace_registry_unavailable",
            "workspace registry unavailable",
            request_id.clone(),
            workspace_id.clone(),
            observed_at,
        )
    })?;
    Ok(registry.get_all().await)
}

fn now() -> String {
    Utc::now().to_rfc3339()
}
