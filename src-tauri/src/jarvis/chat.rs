use std::time::Duration;

use crate::jarvis::actions::PendingAction;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::model::{ModelMessage, ModelRequest, ProviderStatus};
use crate::jarvis::tools::JarvisState;
use crate::jarvis::types::{InvocationBinding, JarvisErrorEnvelope, ToolEnvelope};
use crate::settings::store::{JarvisSettings, ModelProvider as SettingsProvider, SettingsManager};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

mod actions;
mod context;
mod support;
#[cfg(test)]
mod tool_definitions;

pub(crate) use context::{
    build_context_for_chat, build_model_turn_input, follow_ups, read_markdown,
};
pub(crate) use support::{
    ensure_not_cancelled, load_workspace, model_error, now, provider_display_name, request_error,
    status_label, validate_invocation,
};

// Tauri command adapters stay at the public chat seam so `generate_handler!`
// can see the macro-generated command metadata. The stateful implementation
// remains in the cohesive `actions` module.
#[tauri::command]
pub async fn jarvis_confirm_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    actions::jarvis_confirm_action(app, action_id, invocation).await
}

#[tauri::command]
pub async fn jarvis_update_pending_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
    text: String,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    actions::jarvis_update_pending_action(app, action_id, invocation, text).await
}

#[tauri::command]
pub async fn jarvis_reject_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    actions::jarvis_reject_action(app, action_id, invocation).await
}

/// Upper bound for the whole chat request, including tool rounds, plan
/// execution (agent spawn + readiness) and provider calls. Keeps every
/// request bounded even if an internal await stalls.
const CHAT_REQUEST_MAX_DURATION: Duration = Duration::from_secs(180);

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
    let status = app.state::<JarvisState>().model.status(&settings);
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
    let status = state
        .chat_requests
        .cancel(&request_id)
        .map_err(|error| request_error(error, &request_id, None))?;
    state.actions.discard_pending_for_request(&request_id);
    // Spec §18: cancel must also stop the active Codex turn, not only drop
    // the local waiter. Best-effort — the turn may already be over or the
    // thread may not exist yet; `interrupt_turn` is idempotent server-side.
    let registry = app.state::<crate::jarvis::codex::threads::ThreadRegistry>();
    let tools = app.state::<crate::jarvis::codex::tools::CodexToolService>();
    if let Err(error) = registry
        .interrupt_turn_for_request(&request_id, tools.inner())
        .await
    {
        debug!(
            request_id = %request_id,
            error = %error,
            "cancel: turn/interrupt skipped (best-effort)"
        );
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
            let registry = app.state::<crate::jarvis::codex::threads::ThreadRegistry>();
            let tools = app.state::<crate::jarvis::codex::tools::CodexToolService>();
            if let Err(error) = registry
                .interrupt_turn_for_request(&request_id, tools.inner())
                .await
            {
                debug!(
                    request_id = %request_id,
                    workspace_id = %workspace_id,
                    error = %error,
                    "chat timeout: best-effort turn/interrupt failed"
                );
            }
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
    if let Err(error) = &result {
        emit_checkpoint(
            &app,
            &request_id,
            &workspace_id,
            "request",
            &format!("Jarvis: {}", error.message),
            JarvisActivityStatus::Failed,
            None,
        );
    }
    result
}

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
    let recent_memory = state
        .memory
        .recent(&request.invocation.target_workspace_id, 8);
    state.memory.append_with_id(
        &request.invocation.target_workspace_id,
        request.message_id.clone(),
        "user",
        request.message.clone(),
        None,
        false,
    );
    let model_input = build_model_turn_input(&request.message, &context, &recent_memory);
    let messages = vec![ModelMessage::new("user", model_input)];
    let pending_actions = Vec::new();
    let ui_intents = Vec::new();
    let warnings = Vec::new();
    let completion = state
        .model
        .complete(
            ModelRequest {
                messages,
                workspace_id: request.invocation.target_workspace_id.clone(),
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
pub async fn jarvis_clear_conversation(
    app: AppHandle,
    workspace_id: String,
) -> Result<(), JarvisErrorEnvelope> {
    app.state::<JarvisState>().memory.clear(&workspace_id);
    if let Some(registry) = app.try_state::<crate::jarvis::codex::threads::ThreadRegistry>() {
        registry.delete_thread(&workspace_id).await;
    }
    Ok(())
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
