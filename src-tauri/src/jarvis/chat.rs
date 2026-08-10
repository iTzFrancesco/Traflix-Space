use std::time::Duration;

use crate::jarvis::actions::{prompt_bytes, ActionError, PendingAction, PendingActionStatus};
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
#[cfg(test)]
use crate::jarvis::control::conversational_plan_schema;
#[cfg(test)]
use crate::jarvis::model::{ModelFunctionDefinition, ModelToolDefinition};
use crate::jarvis::model::{ModelError, ModelMessage, ModelRequest, ModelToolCall, ProviderStatus};
use crate::jarvis::requests::{ChatRequestError, ChatRequestStatus};
use crate::jarvis::tools::{list_terminals_for_workspace, JarvisState, JarvisToolService};
use crate::jarvis::types::{
    InvocationBinding, JarvisErrorEnvelope, ModelContextViewV1, RequestedDepth, ToolEnvelope,
};
use crate::settings::store::{JarvisSettings, ModelProvider as SettingsProvider, SettingsManager};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use crate::workspace::registry::{WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

const MAX_USER_MESSAGE_BYTES: usize = crate::jarvis::memory::MAX_USER_MESSAGE_BYTES;
/// Upper bound for the whole chat request, including tool rounds, plan
/// execution (agent spawn + readiness) and provider calls. Keeps every
/// request bounded even if an internal await stalls.
const CHAT_REQUEST_MAX_DURATION: Duration = Duration::from_secs(180);

/// The typed conversational-planning tool. Kept as a single constant so the
/// dispatch site, the tool definition and the regression tests cannot drift.
/// Must stay `^[a-zA-Z0-9_-]+$`: OpenCode Zen rejects function names that
/// contain dots with a 400 `Invalid 'tools[0].function.name'` error.
#[cfg(test)]
const CONVERSATIONAL_PLAN_TOOL: &str = "conversational_plan";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisChatRequest {
    pub invocation: InvocationBinding,
    pub message: String,
    #[serde(default)]
    pub message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub workspace_id: String,
    pub created_at: String,
    pub provider: Option<String>,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisUiIntent {
    pub id: String,
    pub kind: String,
    pub workspace_id: String,
    pub terminal_id: String,
    pub generation: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisChatResponse {
    pub invocation: InvocationBinding,
    pub message: JarvisChatMessage,
    pub provider: String,
    pub model_used: String,
    pub primary_model: String,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub pending_actions: Vec<PendingAction>,
    pub ui_intents: Vec<JarvisUiIntent>,
    pub follow_ups: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisProviderStatus {
    pub provider: SettingsProvider,
    pub primary_model: String,
    pub fallback_model: String,
    pub configured: bool,
    pub fallback_enabled: bool,
    pub privacy_consent: bool,
    pub privacy_consent_at: Option<String>,
    pub primary_model_available: bool,
    pub circuit_breaker_until: Option<String>,
    pub circuit_breaker_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisChatRequestStatus {
    pub request_id: String,
    pub status: String,
}

#[tauri::command]
pub async fn jarvis_provider_status(
    app: AppHandle,
) -> Result<JarvisProviderStatus, JarvisErrorEnvelope> {
    let settings = app.state::<SettingsManager>().get().await.jarvis;
    let status = app
        .state::<JarvisState>()
        .model
        .status(&settings);
    Ok(status.into())
}

#[tauri::command]
pub async fn jarvis_pending_actions(
    app: AppHandle,
) -> Result<ToolEnvelope<Vec<PendingAction>>, JarvisErrorEnvelope> {
    Ok(ToolEnvelope {
        data: app.state::<JarvisState>().actions.list(),
        provenance: crate::jarvis::types::Provenance::trusted("jarvis-actions", &now()),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn jarvis_conversation_history(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<JarvisChatMessage>, JarvisErrorEnvelope> {
    if workspace_id.trim().is_empty() {
        return Err(JarvisErrorEnvelope::new(
            "workspace_not_found",
            "workspace is required",
            None,
            None,
            now(),
        ));
    }
    Ok(app
        .state::<JarvisState>()
        .memory
        .recent(
            &workspace_id,
            crate::jarvis::memory::MAX_MESSAGES_PER_WORKSPACE,
        )
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
pub async fn jarvis_chat_status(
    app: AppHandle,
    request_id: String,
) -> Result<JarvisChatRequestStatus, JarvisErrorEnvelope> {
    let status = app
        .state::<JarvisState>()
        .chat_requests
        .status(&request_id)
        .map_err(|error| request_error(error, &request_id, None))?;
    Ok(JarvisChatRequestStatus {
        request_id,
        status: status_label(status).to_string(),
    })
}

#[tauri::command]
pub async fn jarvis_cancel_chat(
    app: AppHandle,
    request_id: String,
) -> Result<JarvisChatRequestStatus, JarvisErrorEnvelope> {
    let state = app.state::<JarvisState>();
    let workspace_id = state.chat_requests.workspace_id_of(&request_id);
    let status = state
        .chat_requests
        .cancel(&request_id)
        .map_err(|error| request_error(error, &request_id, None))?;
    state.actions.discard_pending_for_request(&request_id);
    // Spec §18: cancel must also stop the active Codex turn, not only drop
    // the local waiter. Best-effort — the turn may already be over or the
    // thread may not exist yet; `interrupt_turn` is idempotent server-side.
    if let Some(workspace_id) = workspace_id {
        let registry = app.state::<crate::jarvis::codex::threads::ThreadRegistry>();
        let tools = app.state::<crate::jarvis::codex::tools::CodexToolService>();
        if let Err(error) = registry.interrupt_turn(&workspace_id, tools.inner()).await {
            debug!(
                request_id = %request_id,
                workspace_id = %workspace_id,
                error = %error,
                "cancel: turn/interrupt skipped (best-effort)"
            );
        }
    }
    Ok(JarvisChatRequestStatus {
        request_id,
        status: status_label(status).to_string(),
    })
}

#[tauri::command]
pub async fn jarvis_chat(
    app: AppHandle,
    request: JarvisChatRequest,
) -> Result<JarvisChatResponse, JarvisErrorEnvelope> {
    let observed_at = now();
    validate_invocation(&request.invocation, &request.message, &observed_at)?;
    let state = app.state::<JarvisState>();
    let cancellation = state
        .chat_requests
        .start(
            &request.invocation.request_id,
            &request.invocation.target_workspace_id,
        )
        .map_err(|error| {
            request_error(
                error,
                &request.invocation.request_id,
                Some(&request.invocation),
            )
        })?;
    let request_id = request.invocation.request_id.clone();
    let workspace_id = request.invocation.target_workspace_id.clone();
    let message_preview: String = request.message.chars().take(200).collect();
    info!(
        request_id = %request_id,
        workspace_id = %workspace_id,
        message_chars = request.message.chars().count(),
        message = %message_preview,
        "Jarvis chat request started"
    );
    // Any backend stall (PTY lock, provider queue, agent readiness) must never
    // leave the request pending forever: the frontend already times out its
    // invoke, but the backend has to release the request slot and reply with
    // a bounded error instead of leaking the task.
    let result = match tokio::time::timeout(
        CHAT_REQUEST_MAX_DURATION,
        run_chat(&app, request, cancellation),
    )
    .await
    {
        Ok(result) => result,
        Err(_elapsed) => {
            warn!(
                request_id = %request_id,
                timeout_s = CHAT_REQUEST_MAX_DURATION.as_secs(),
                "Jarvis chat request timed out"
            );
            Err(JarvisErrorEnvelope::new(
                "chat_request_timeout",
                "La richiesta ha impiegato troppo tempo ed è stata interrotta. Riprova tra poco.",
                Some(request_id.clone()),
                Some(workspace_id.clone()),
                &observed_at,
            ))
        }
    };
    state.chat_requests.finish(&request_id);
    match &result {
        Ok(response) => info!(
            request_id = %request_id,
            response_chars = response.message.content.chars().count(),
            "Jarvis chat request completed"
        ),
        Err(error) => error!(
            request_id = %request_id,
            error_code = %error.code,
            "Jarvis chat request failed"
        ),
    }
    result
}

/// Close an open checkpoint on a failed chat setup so the ephemeral strip
/// never keeps a stale running row for a failed request.
fn fail_open_checkpoint(app: &AppHandle, invocation: &InvocationBinding, phase: &str, label: &str) {
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        phase,
        label,
        JarvisActivityStatus::Failed,
        None,
    );
}

async fn run_chat(
    app: &AppHandle,
    request: JarvisChatRequest,
    cancellation: CancellationToken,
) -> Result<JarvisChatResponse, JarvisErrorEnvelope> {
    let observed_at = now();
    emit_checkpoint(
        app,
        &request.invocation.request_id,
        &request.invocation.target_workspace_id,
        "checking_agents",
        "Checking agents…",
        JarvisActivityStatus::Running,
        None,
    );
    let workspace = match load_workspace(
        app,
        &request.invocation.target_workspace_id,
        &request.invocation.request_id,
        &observed_at,
    )
    .await
    {
        Ok(workspace) => workspace,
        Err(error) => {
            fail_open_checkpoint(
                app,
                &request.invocation,
                "checking_agents",
                "Checking agents…",
            );
            return Err(error);
        }
    };
    if let Err(error) = ensure_not_cancelled(&cancellation, &request.invocation, &observed_at) {
        fail_open_checkpoint(
            app,
            &request.invocation,
            "checking_agents",
            "Checking agents…",
        );
        return Err(error);
    }
    let context = match build_context_for_chat(app, &workspace, request.invocation.clone()).await {
        Ok(context) => context,
        Err(error) => {
            fail_open_checkpoint(
                app,
                &request.invocation,
                "checking_agents",
                "Checking agents…",
            );
            return Err(error);
        }
    };
    let context_chars = serde_json::to_string(&context)
        .map(|serialized| serialized.chars().count())
        .unwrap_or(0);
    info!(
        request_id = %request.invocation.request_id,
        context_chars = context_chars,
        terminals = context.terminals.len(),
        agents = context.agent_sessions.len(),
        documents = context.document_index.len(),
        "Jarvis chat context built"
    );
    emit_checkpoint(
        app,
        &request.invocation.request_id,
        &request.invocation.target_workspace_id,
        "checking_agents",
        "Checking agents…",
        JarvisActivityStatus::Done,
        None,
    );
    let state = app.state::<JarvisState>();
    let settings: JarvisSettings = app.state::<SettingsManager>().get().await.jarvis;
    info!(
        request_id = %request.invocation.request_id,
        codex_model = %settings.codex.model,
        codex_reasoning = %settings.codex.reasoning_effort,
        "Jarvis chat model configuration loaded"
    );
    state.memory.append_with_id(
        &request.invocation.target_workspace_id,
        request.message_id.clone(),
        "user",
        request.message.clone(),
        None,
        false,
    );
    let messages = vec![ModelMessage::new("user", request.message.clone())];
    let pending_actions = Vec::new();
    let ui_intents = Vec::new();
    let warnings = Vec::new();

    // C10 + spec §27: no more `for round in 0..MAX_TOOL_ROUNDS`. The Codex
    // App Server holds the turn alive; the provider completes it with the
    // final agent message (thread history is the conversation memory, spec
    // §20 — the UI memory below stays authoritative for the frontend).
    let completion = state
        .model
        .complete(
            ModelRequest {
                messages,
                // C10: the completion runs on the workspace's Codex
                // thread; the provider needs the binding.
                workspace_id: request.invocation.target_workspace_id.clone(),
                // Review #12: correlate the streamed turn to this app
                // request (turn_id -> request_id telemetry).
                request_id: Some(request.invocation.request_id.clone()),
            },
            cancellation.clone(),
        )
        .await
        .map_err(|error| model_error(error, &request.invocation, &observed_at))?;
    let final_content = completion.response.content;

    ensure_not_cancelled(&cancellation, &request.invocation, &observed_at)?;
    let assistant_memory = state.memory.append(
        &request.invocation.target_workspace_id,
        "assistant",
        final_content,
        Some(completion.model_used.clone()),
        false,
    );
    let follow_ups = follow_ups(&context);
    Ok(JarvisChatResponse {
        invocation: request.invocation,
        message: assistant_memory.into(),
        provider: "codex".to_string(),
        model_used: completion.model_used.clone(),
        // Review #7: single source of truth — the thread model is the model.
        primary_model: completion.model_used,
        fallback_used: false,
        fallback_reason: None,
        pending_actions,
        ui_intents,
        follow_ups,
        warnings,
    })
}

#[tauri::command]
pub async fn jarvis_confirm_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    let state = app.state::<JarvisState>();
    let record = state
        .actions
        .take_for_confirmation(&action_id, &invocation)
        .map_err(|error| action_error(error, &invocation, &observed_at))?;
    let terminal_id = record.action.terminal_id.clone().ok_or_else(|| {
        action_failure(
            "terminal target missing",
            "terminal_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    let manager = app.state::<TerminalManager>();
    let snapshot = manager
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != invocation.target_workspace_id {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "workspace del terminale non corrisponde",
            "invocation_mismatch",
            &invocation,
            &observed_at,
        ));
    }
    if record.action.generation != Some(snapshot.generation) {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "la generazione del terminale è cambiata",
            "terminal_generation_changed",
            &invocation,
            &observed_at,
        ));
    }
    if !snapshot.process_alive {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "il processo del terminale non è vivo",
            "terminal_not_alive",
            &invocation,
            &observed_at,
        ));
    }
    let provider_label = record
        .action
        .provider
        .as_deref()
        .map(provider_display_name)
        .unwrap_or_else(|| "agente".to_string());
    let target_session_id = crate::jarvis::agent_registry::session_id_for(&snapshot);
    let result = match record.action.operation.as_str() {
        "agent_send" => {
            if !snapshot.is_agent_terminal
                || !state
                    .registry
                    .control_allowed(&terminal_id, snapshot.generation)
            {
                Err("target is not a confirmed agent".to_string())
            } else {
                let text = record
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                emit_checkpoint(
                    &app,
                    &invocation.request_id,
                    &invocation.target_workspace_id,
                    "writing",
                    &format!("Writing to {provider_label}…"),
                    JarvisActivityStatus::Running,
                    Some(target_session_id.clone()),
                );
                match prompt_bytes(text) {
                    Ok(bytes) => {
                        let written = manager
                            .write_typed_for_generation(
                                &app,
                                &terminal_id,
                                snapshot.generation,
                                &bytes,
                                TerminalInputOrigin::JarvisPrompt,
                            )
                            .await;
                        if written.is_ok() {
                            // Register the task only after a successful PTY
                            // write; the backend knows the exact text, so
                            // provenance and confidence are high.
                            state.registry.observe_jarvis_send(&snapshot, text, &now());
                        }
                        written
                    }
                    Err(_) => Err("invalid action payload".to_string()),
                }
            }
        }
        "agent_abort" => {
            if !snapshot.is_agent_terminal
                || !state
                    .registry
                    .control_allowed(&terminal_id, snapshot.generation)
            {
                Err("target is not a confirmed agent".to_string())
            } else {
                emit_checkpoint(
                    &app,
                    &invocation.request_id,
                    &invocation.target_workspace_id,
                    "interrupting",
                    &format!("Interrupting {provider_label}…"),
                    JarvisActivityStatus::Running,
                    Some(target_session_id.clone()),
                );
                manager
                    .write_typed_for_generation(
                        &app,
                        &terminal_id,
                        snapshot.generation,
                        &[0x03],
                        TerminalInputOrigin::JarvisAbort,
                    )
                    .await
            }
        }
        "terminal_kill" => {
            manager
                .kill_generation(&app, &terminal_id, snapshot.generation)
                .await
        }
        _ => Err("unsupported action".to_string()),
    };
    match result {
        Ok(()) => {
            emit_checkpoint(
                &app,
                &invocation.request_id,
                &invocation.target_workspace_id,
                "sent",
                "Sent.",
                JarvisActivityStatus::Done,
                None,
            );
            state
                .actions
                .finish(&action_id, PendingActionStatus::Confirmed)
                .ok_or_else(|| {
                    action_failure(
                        "action state unavailable",
                        "action_not_pending",
                        &invocation,
                        &observed_at,
                    )
                })
        }
        Err(error) => {
            emit_checkpoint(
                &app,
                &invocation.request_id,
                &invocation.target_workspace_id,
                "writing",
                "Scrittura non riuscita.",
                JarvisActivityStatus::Failed,
                None,
            );
            state
                .actions
                .finish(&action_id, PendingActionStatus::Failed);
            let code = if error.contains("agent") {
                "target_not_agent"
            } else if error.contains("invalid") {
                "action_payload_invalid"
            } else {
                "terminal_operation_failed"
            };
            Err(action_failure(
                "operazione terminale non eseguita",
                code,
                &invocation,
                &observed_at,
            ))
        }
    }
}

#[tauri::command]
pub async fn jarvis_update_pending_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
    text: String,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    let state = app.state::<JarvisState>();
    let record = state.actions.record(&action_id).ok_or_else(|| {
        action_failure(
            "operazione non trovata",
            "action_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    if record.action.invocation.request_id != invocation.request_id
        || record.action.invocation.target_workspace_id != invocation.target_workspace_id
    {
        return Err(action_failure(
            "invocation non corrispondente",
            "invocation_mismatch",
            &invocation,
            &observed_at,
        ));
    }
    let terminal_id = record.action.terminal_id.as_deref().ok_or_else(|| {
        action_failure(
            "terminal target missing",
            "terminal_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(terminal_id)
        .await
        .map_err(|_| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != invocation.target_workspace_id
        || record.action.generation != Some(snapshot.generation)
        || !snapshot.process_alive
        || !snapshot.is_agent_terminal
        || !state
            .registry
            .control_allowed(terminal_id, snapshot.generation)
    {
        return Err(action_failure(
            "target terminale non più valido",
            "terminal_generation_changed",
            &invocation,
            &observed_at,
        ));
    }
    state
        .actions
        .update_agent_send(&action_id, &invocation, &text)
        .map_err(|error| action_error(error, &invocation, &observed_at))
}

#[tauri::command]
pub async fn jarvis_reject_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    app.state::<JarvisState>()
        .actions
        .take_for_confirmation(&action_id, &invocation)
        .map_err(|error| action_error(error, &invocation, &observed_at))?;
    app.state::<JarvisState>()
        .actions
        .finish(&action_id, PendingActionStatus::Rejected)
        .ok_or_else(|| {
            action_failure(
                "action state unavailable",
                "action_not_pending",
                &invocation,
                &observed_at,
            )
        })
}

#[tauri::command]
pub async fn jarvis_clear_conversation(
    app: AppHandle,
    workspace_id: String,
) -> Result<(), JarvisErrorEnvelope> {
    app.state::<JarvisState>().memory.clear(&workspace_id);
    // C4: Clear Conversation also destroys the ephemeral Codex thread for
    // that workspace (spec §9). Best-effort: when the runtime is down the
    // server thread is left orphaned (documented V1 limit).
    if let Some(registry) = app.try_state::<crate::jarvis::codex::threads::ThreadRegistry>() {
        registry.delete_thread(&workspace_id).await;
    }
    Ok(())
}

async fn build_context_for_chat(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: InvocationBinding,
) -> Result<ModelContextViewV1, JarvisErrorEnvelope> {
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, workspace, &invocation.created_at).await;
    let all_agents = manager.list_agent_snapshots().await;
    app.state::<JarvisState>()
        .registry
        .reconcile(&all_agents, &invocation.created_at);
    JarvisToolService::new(&app.state::<JarvisState>().broker)
        .build_context(workspace, invocation, terminals, RequestedDepth::LastResult)
        .and_then(|package| {
            package.to_model_context_view(&[]).map_err(|_| {
                JarvisErrorEnvelope::new(
                    "context_projection_failed",
                    "context projection failed",
                    None,
                    Some(workspace.id.clone()),
                    now(),
                )
            })
        })
}

pub(crate) async fn execute_read_tool(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    call: ModelToolCall,
    args: &Value,
    context: &ModelContextViewV1,
) -> (Value, Option<JarvisUiIntent>) {
    if call.function.name == "ui_open_terminal" {
        let terminal_id = args
            .get("terminalId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(terminal) = context.terminals.iter().find(|terminal| {
            terminal.terminal_id == terminal_id
                && terminal.workspace_id == invocation.target_workspace_id
        }) else {
            return (
                json!({"error":"terminal target is not owned by invocation workspace"}),
                None,
            );
        };
        let intent = JarvisUiIntent {
            id: format!("jarvis-ui:{}", invocation.request_id),
            kind: "open_terminal".to_string(),
            workspace_id: invocation.target_workspace_id.clone(),
            terminal_id: terminal_id.to_string(),
            generation: terminal.generation,
            label: "Apri terminale".to_string(),
        };
        return (
            json!({"intent":"open_terminal","executed":false}),
            Some(intent),
        );
    }
    let read_checkpoint: Option<(String, String, Option<String>)> =
        match call.function.name.as_str() {
            "agent_list" => Some((
                "checking_agents".to_string(),
                "Checking agents…".to_string(),
                None,
            )),
            "agent_status" => {
                let session_id = args
                    .get("agentSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let label = context
                    .agent_sessions
                    .iter()
                    .find(|session| session.reference.agent_session_id == session_id)
                    .map(|session| {
                        format!(
                            "Checking {}…",
                            provider_display_name(&session.resolved_provider)
                        )
                    })
                    .unwrap_or_else(|| "Checking agent…".to_string());
                Some((
                    "checking_agent".to_string(),
                    label,
                    Some(session_id.to_string()),
                ))
            }
            "agent_last_result" => Some((
                "reading_result".to_string(),
                "Reading last result…".to_string(),
                args.get("agentSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )),
            "agent_activity" => Some((
                "reading_activity".to_string(),
                "Reading agent timeline…".to_string(),
                args.get("agentSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )),
            "agent_tail" => Some((
                "reading_tail".to_string(),
                "Reading terminal tail…".to_string(),
                args.get("terminalId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )),
            _ => None,
        };
    if let Some((phase, label, target)) = &read_checkpoint {
        emit_checkpoint(
            app,
            &invocation.request_id,
            &invocation.target_workspace_id,
            phase,
            label,
            JarvisActivityStatus::Running,
            target.clone(),
        );
    }
    let result = match call.function.name.as_str() {
        // Model-visible workspace metadata is intentionally restricted to the
        // invocation workspace. Jarvis may not enumerate or merge unrelated
        // workspace names/counts while deciding what to do in the focused one.
        "workspace_overview" => json!({
            "id": workspace.id,
            "name": workspace.name,
            "terminalCount": workspace.terminals.len()
        }),
        "terminal_list" => {
            serde_json::to_value(context.terminals.clone()).unwrap_or_else(|_| json!([]))
        }
        "agent_list" => {
            serde_json::to_value(context.agent_sessions.clone()).unwrap_or_else(|_| json!([]))
        }
        "agent_status" => {
            let session_id = args
                .get("agentSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            context
                .agent_sessions
                .iter()
                .find(|session| session.reference.agent_session_id == session_id)
                .map(|session| {
                    serde_json::to_value(session)
                        .unwrap_or_else(|_| json!({"error":"agent status unavailable"}))
                })
                .unwrap_or_else(|| json!({"error":"agent_session_not_found"}))
        }
        "agent_last_result" => {
            let session_id = args
                .get("agentSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            context
                .agent_sessions
                .iter()
                .find(|session| session.reference.agent_session_id == session_id)
                .and_then(|session| session.last_result.clone())
                .map(|result| {
                    serde_json::to_value(result)
                        .unwrap_or_else(|_| json!({"error":"result unavailable"}))
                })
                .unwrap_or_else(|| json!({"error":"agent session or result unavailable"}))
        }
        "agent_activity" => {
            let session_id = args
                .get("agentSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(crate::jarvis::agent_registry::DEFAULT_ACTIVITY_LIMIT as u64)
                .min(crate::jarvis::agent_registry::MAX_ACTIVITY_LIMIT as u64)
                .max(1) as usize;
            let session = context
                .agent_sessions
                .iter()
                .find(|session| session.reference.agent_session_id == session_id);
            let Some(session) = session else {
                return (json!({"error":"agent_session_not_found"}), None);
            };
            match app
                .state::<JarvisState>()
                .broker
                .source()
                .get_activity(&session.reference, limit)
            {
                Ok(events) => serde_json::to_value(events)
                    .unwrap_or_else(|_| json!({"error":"activity unavailable"})),
                Err(_) => json!({"error":"agent activity unavailable"}),
            }
        }
        "agent_tail" => {
            let terminal_id = args
                .get("terminalId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let generation = args
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            let Some(terminal) = context.terminals.iter().find(|terminal| {
                terminal.terminal_id == terminal_id
                    && terminal.workspace_id == invocation.target_workspace_id
                    && terminal.generation == generation
            }) else {
                return (json!({"error":"terminal generation mismatch"}), None);
            };
            match app
                .state::<TerminalManager>()
                .get_recent_normalized_terminal_text_for_runtime(
                    terminal_id,
                    &terminal.workspace_id,
                    terminal.generation,
                    terminal.process_id,
                    crate::jarvis::control::MAX_TAIL_BYTES,
                )
                .await
            {
                Ok(raw) => serde_json::to_value(crate::jarvis::control::build_tail(
                    &terminal.workspace_id,
                    terminal_id,
                    generation,
                    &raw.content,
                    args.get("maxLines")
                        .and_then(Value::as_u64)
                        .unwrap_or(crate::jarvis::control::DEFAULT_TAIL_LINES as u64)
                        as usize,
                    raw.truncated,
                ))
                .unwrap_or_else(|_| json!({"error":"terminal tail unavailable"})),
                Err(_) => json!({"error":"terminal tail unavailable"}),
            }
        }
        "markdown_read" => {
            let path = args
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match read_markdown(app, workspace, invocation.clone(), path.to_string()).await {
                Ok(value) => serde_json::to_value(value)
                    .unwrap_or_else(|_| json!({"error":"document unavailable"})),
                Err(_) => json!({"error":"document rejected by context policy"}),
            }
        }
        _ => json!({"error":"unknown read-only tool"}),
    };
    if let Some((phase, label, target)) = read_checkpoint {
        let failed = result.get("error").is_some();
        emit_checkpoint(
            app,
            &invocation.request_id,
            &invocation.target_workspace_id,
            &phase,
            &label,
            if failed {
                JarvisActivityStatus::Failed
            } else {
                JarvisActivityStatus::Done
            },
            target,
        );
    }
    (result, None)
}

async fn read_markdown(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: InvocationBinding,
    path: String,
) -> Result<ModelContextViewV1, JarvisErrorEnvelope> {
    let manager = app.state::<TerminalManager>();
    let terminals = list_terminals_for_workspace(&manager, workspace, &invocation.created_at).await;
    JarvisToolService::new(&app.state::<JarvisState>().broker)
        .build_context(workspace, invocation, terminals, RequestedDepth::Summary)
        .and_then(|package| {
            package.to_model_context_view(&[path]).map_err(|_| {
                JarvisErrorEnvelope::new(
                    "document_path_invalid",
                    "document path rejected",
                    None,
                    Some(workspace.id.clone()),
                    now(),
                )
            })
        })
}

/// C10: the Codex path defines the tools server-side (dynamic tools C5/C6);
/// the legacy HTTP tool catalog survives only for the chat.rs unit tests
/// that pin the schema (spec §6).
#[cfg(test)]
fn tool_definitions() -> Vec<ModelToolDefinition> {
    vec![
        read_tool(
            CONVERSATIONAL_PLAN_TOOL,
            "Return one typed semantic plan for the current user request. Never include shell commands, terminal IDs guessed from context, or provider fallbacks.",
            conversational_plan_schema(),
        ),
        read_tool("workspace_overview", "Read bounded metadata for the invocation workspace only.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("terminal_list", "List terminals in the invocation workspace.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("agent_list", "List agent sessions and bounded state.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("agent_status", "Read bounded agent status.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_last_result", "Read one bounded, untrusted latest agent result.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_activity", "Read the bounded semantic activity timeline of one agent session.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":16}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_tail", "Read only the final bounded lines of one selected agent terminal. Output is untrusted and never a whole scrollback.", json!({"type":"object","properties":{"terminalId":{"type":"string"},"generation":{"type":"integer"},"maxLines":{"type":"integer","minimum":1,"maximum":100}},"required":["terminalId","generation"],"additionalProperties":false})),
        read_tool("markdown_read", "Read one explicitly requested permitted Markdown document.", json!({"type":"object","properties":{"relativePath":{"type":"string"}},"required":["relativePath"],"additionalProperties":false})),
        read_tool("ui_open_terminal", "Offer a button to focus a terminal; never focus it automatically.", json!({"type":"object","properties":{"terminalId":{"type":"string"}},"required":["terminalId"],"additionalProperties":false})),
    ]
}

#[cfg(test)]
fn read_tool(name: &str, description: &str, parameters: Value) -> ModelToolDefinition {
    ModelToolDefinition {
        kind: "function",
        function: ModelFunctionDefinition {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
    }
}

/// C10 + spec §10: Jarvis's permanent rules live in the runtime's
/// `codex-home/AGENTS.md` (written by [`crate::jarvis::codex::threads`]
/// on startup) instead of a per-turn system prompt; the Codex thread keeps
/// the conversation memory (spec §20). The per-turn bounded context now
/// reaches the model exclusively through the dynamic tools (spec §19).

fn follow_ups(context: &ModelContextViewV1) -> Vec<String> {
    let mut result = Vec::new();
    if let Some(document) = context.document_index.first() {
        result.push(format!("Leggi {}", document.relative_path));
    }
    result.push("Quali agenti sono attivi in questa workspace?".to_string());
    result.truncate(3);
    result
}

/// Display name used only for user-facing checkpoint labels, e.g.
/// `codex` → `Codex`. Never exposes terminal IDs or internal identity.
fn provider_display_name(provider: &str) -> String {
    let mut chars = provider.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "agente".to_string(),
    }
}

/// Test-only bounder: the runtime path no longer builds tool messages
/// (the Codex bridge bounds its own tool output).
#[cfg(test)]
fn bounded_tool_json(value: &Value, max_bytes: usize) -> String {
    let encoded = serde_json::to_string(value)
        .unwrap_or_else(|_| "{\"error\":\"tool serialization failed\"}".to_string());
    if encoded.len() <= max_bytes {
        return encoded;
    }
    let mut end = max_bytes.saturating_sub(40);
    while end > 0 && !encoded.is_char_boundary(end) {
        end -= 1;
    }
    serde_json::to_string(&json!({"untrusted":true,"truncated":true,"content":encoded[..end]}))
        .unwrap_or_else(|_| "{\"truncated\":true}".to_string())
}

fn validate_invocation(
    invocation: &InvocationBinding,
    message: &str,
    observed_at: &str,
) -> Result<(), JarvisErrorEnvelope> {
    if invocation.request_id.trim().is_empty() || invocation.target_workspace_id.trim().is_empty() {
        return Err(JarvisErrorEnvelope::new(
            "invocation_invalid",
            "request e workspace sono obbligatori",
            Some(invocation.request_id.clone()),
            Some(invocation.target_workspace_id.clone()),
            observed_at,
        ));
    }
    if message.trim().is_empty() || message.len() > MAX_USER_MESSAGE_BYTES {
        return Err(JarvisErrorEnvelope::new(
            "message_invalid",
            "messaggio vuoto o oltre il limite",
            Some(invocation.request_id.clone()),
            Some(invocation.target_workspace_id.clone()),
            observed_at,
        ));
    }
    Ok(())
}

pub(crate) async fn load_workspace(
    app: &AppHandle,
    workspace_id: &str,
    request_id: &str,
    observed_at: &str,
) -> Result<WorkspaceConfig, JarvisErrorEnvelope> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await.map_err(|_| {
        JarvisErrorEnvelope::new(
            "workspace_not_found",
            "workspace non disponibile",
            Some(request_id.to_string()),
            Some(workspace_id.to_string()),
            observed_at,
        )
    })?;
    registry.get(workspace_id).await.ok_or_else(|| {
        JarvisErrorEnvelope::new(
            "workspace_not_found",
            "workspace non trovata",
            Some(request_id.to_string()),
            Some(workspace_id.to_string()),
            observed_at,
        )
    })
}

fn ensure_not_cancelled(
    cancellation: &CancellationToken,
    invocation: &InvocationBinding,
    observed_at: &str,
) -> Result<(), JarvisErrorEnvelope> {
    if cancellation.is_cancelled() {
        Err(JarvisErrorEnvelope::new(
            "chat_cancelled",
            "richiesta annullata",
            Some(invocation.request_id.clone()),
            Some(invocation.target_workspace_id.clone()),
            observed_at,
        ))
    } else {
        Ok(())
    }
}

fn model_error(
    error: ModelError,
    invocation: &InvocationBinding,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    let (code, message) = match error {
        // C10: the Codex App Server is the only provider; the legacy HTTP
        // error taxonomy (auth/forbidden/rate/transport/…) is gone.
        ModelError::NotConfigured => (
            "model_provider_not_configured",
            "il runtime Codex non è disponibile (avvia Codex App Server)",
        ),
        ModelError::Server => (
            "model_server_error",
            "il provider è temporaneamente indisponibile",
        ),
        ModelError::Timeout => ("model_timeout", "il provider ha superato il timeout"),
        ModelError::InvalidPayload => ("model_payload_invalid", "richiesta locale non valida"),
        ModelError::Cancelled => ("chat_cancelled", "richiesta annullata"),
    };
    JarvisErrorEnvelope::new(
        code,
        message,
        Some(invocation.request_id.clone()),
        Some(invocation.target_workspace_id.clone()),
        observed_at,
    )
}

fn action_error(
    error: ActionError,
    invocation: &InvocationBinding,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    let (code, message) = match error {
        ActionError::NotFound => ("action_not_found", "operazione non trovata"),
        ActionError::NotPending => ("action_not_pending", "operazione già gestita"),
        ActionError::InvocationMismatch => (
            "invocation_mismatch",
            "operazione appartenente a un'altra richiesta",
        ),
        ActionError::Expired => ("action_expired", "operazione scaduta"),
        ActionError::PayloadInvalid => {
            ("action_payload_invalid", "testo dell'operazione non valido")
        }
    };
    JarvisErrorEnvelope::new(
        code,
        message,
        Some(invocation.request_id.clone()),
        Some(invocation.target_workspace_id.clone()),
        observed_at,
    )
}

fn action_failure(
    message: &str,
    code: &str,
    invocation: &InvocationBinding,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    JarvisErrorEnvelope::new(
        code,
        message,
        Some(invocation.request_id.clone()),
        Some(invocation.target_workspace_id.clone()),
        observed_at,
    )
}

fn request_error(
    error: ChatRequestError,
    request_id: &str,
    invocation: Option<&InvocationBinding>,
) -> JarvisErrorEnvelope {
    let (code, message) = match error {
        ChatRequestError::AlreadyRunning => (
            "request_already_running",
            "esiste già una richiesta in questa workspace",
        ),
        ChatRequestError::RegistryFull => {
            ("request_registry_full", "troppe richieste Jarvis attive")
        }
        ChatRequestError::NotFound => ("request_not_found", "richiesta non trovata"),
        #[cfg(test)]
        ChatRequestError::Cancelled => ("chat_cancelled", "richiesta annullata"),
    };
    JarvisErrorEnvelope::new(
        code,
        message,
        Some(request_id.to_string()),
        invocation.map(|value| value.target_workspace_id.clone()),
        now(),
    )
}

fn status_label(status: ChatRequestStatus) -> &'static str {
    match status {
        ChatRequestStatus::Running => "running",
        ChatRequestStatus::CancellationRequested => "cancellation_requested",
    }
}
pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

impl From<ProviderStatus> for JarvisProviderStatus {
    fn from(status: ProviderStatus) -> Self {
        Self {
            provider: status.provider,
            primary_model: status.primary_model,
            fallback_model: status.fallback_model,
            configured: status.configured,
            fallback_enabled: status.fallback_enabled,
            privacy_consent: status.privacy_consent,
            privacy_consent_at: status.privacy_consent_at,
            primary_model_available: status.primary_model_available,
            circuit_breaker_until: status.circuit_breaker_until,
            circuit_breaker_reason: status.circuit_breaker_reason,
        }
    }
}

impl From<crate::jarvis::memory::MemoryMessage> for JarvisChatMessage {
    fn from(message: crate::jarvis::memory::MemoryMessage) -> Self {
        Self {
            id: message.id,
            role: message.role,
            content: message.content,
            workspace_id: message.workspace_id,
            created_at: message.created_at,
            provider: message.provider,
            untrusted: message.untrusted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_tool_json, tool_definitions, CONVERSATIONAL_PLAN_TOOL};
    use serde_json::json;

    /// Regression for the OpenAI 400 `Invalid 'tools[0].function.name':
    /// string does not match pattern`: function names must match the
    /// grammar `^[a-zA-Z0-9_-]+$` (no dots, spaces or reserved characters).
    #[test]
    fn tool_names_follow_openai_function_name_pattern() {
        let tools = tool_definitions();
        assert!(!tools.is_empty());
        for tool in &tools {
            let name = &tool.function.name;
            assert!(
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "tool name {name:?} violates the OpenAI function name pattern",
            );
            assert_eq!(tool.kind, "function");
        }
    }

    /// The dispatch site, the tool definition and the system prompt must all
    /// reference the same tool name; a mismatch silently kills planning.
    #[test]
    fn conversational_plan_name_is_consistent_across_dispatch_prompt_and_definition() {
        let tools = tool_definitions();
        let plan = tools
            .iter()
            .find(|tool| tool.function.name == CONVERSATIONAL_PLAN_TOOL)
            .expect("conversational_plan tool is defined");
        assert_eq!(plan.function.name, CONVERSATIONAL_PLAN_TOOL);
        assert!(!plan.function.name.contains('.'));
    }

    #[test]
    fn bounded_tool_output_remains_valid_json_at_utf8_boundary() {
        let output = bounded_tool_json(&json!({"content":"é".repeat(20_000)}), 128);
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["truncated"], true);
    }
}
