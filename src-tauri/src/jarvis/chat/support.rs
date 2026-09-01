use crate::jarvis::actions::ActionError;
use crate::jarvis::model::ModelError;
use crate::jarvis::requests::{ChatRequestError, ChatRequestStatus};
use crate::jarvis::types::{InvocationBinding, JarvisErrorEnvelope};
use crate::workspace::registry::{WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use tauri::{AppHandle, Manager};

const MAX_USER_MESSAGE_BYTES: usize = crate::jarvis::memory::MAX_USER_MESSAGE_BYTES;

pub(crate) fn validate_invocation(
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

pub(crate) fn ensure_not_cancelled(
    cancellation: &tokio_util::sync::CancellationToken,
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

pub(crate) fn model_error(
    error: ModelError,
    invocation: &InvocationBinding,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    let (code, message) = match error {
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

pub(crate) fn action_error(
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

pub(crate) fn action_failure(
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

pub(crate) fn request_error(
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

pub(crate) fn status_label(status: ChatRequestStatus) -> &'static str {
    match status {
        ChatRequestStatus::Running => "running",
        ChatRequestStatus::CancellationRequested => "cancellation_requested",
    }
}

pub(crate) fn provider_display_name(provider: &str) -> String {
    let value = provider.trim();
    match value.to_ascii_lowercase().as_str() {
        "anti-gravity" | "agy" => "Anti-Gravity".to_string(),
        "claude" | "cloud" => "Claude".to_string(),
        "claudex" | "cloudx" => "Claudex".to_string(),
        "codex" => "Codex".to_string(),
        "opencode" => "OpenCode".to_string(),
        "pi" | "p" => "PI".to_string(),
        "cmdc" | "command code" => "Command Code".to_string(),
        "cline" => "Cline".to_string(),
        "freebuff" => "Freebuff".to_string(),
        "grok" => "Grok".to_string(),
        _ if value.is_empty() => "agente".to_string(),
        _ => {
            let mut chars = value.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_else(|| "agente".to_string())
        }
    }
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}
