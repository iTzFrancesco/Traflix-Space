use crate::jarvis::tools::{list_terminals_for_workspace, JarvisState, JarvisToolService};
use crate::jarvis::types::{
    AgentMessage, AgentResult, AgentSessionContext, AgentSessionRef, ContextPackageV1,
    InvocationBinding, JarvisErrorEnvelope, ModelContextViewV1, RequestedDepth, TerminalSummary,
    ToolEnvelope, WorkspaceSummary,
};
use crate::terminal_engine::TerminalManager;
use crate::workspace::registry::{WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use tauri::{AppHandle, Manager};

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
    let _workspace = load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, &workspace_id, &observed_at).await;
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
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    JarvisToolService::new(&app.state::<JarvisState>().broker).agent_list(
        &workspace_id,
        request_id,
        &observed_at,
    )
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
    load_workspace(
        &workspace_registry,
        &workspace_id,
        request_id.clone(),
        &observed_at,
    )
    .await?;
    JarvisToolService::new(&app.state::<JarvisState>().broker).agent_status(
        &workspace_id,
        &agent_session_id,
        request_id,
        &observed_at,
    )
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
        list_terminals_for_workspace(&manager, &workspace_id, &invocation.created_at).await;
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
