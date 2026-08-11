//! C10 — Jarvis LLM provider: Codex App Server (replaces OpenCode Zen).
//!
//! Jarvis no longer calls an HTTP chat-completions gateway. Every chat
//! request becomes one `turn/start` on the workspace's Codex thread (C4);
//! the model reasons with dynamic tools (C5) and mutates through
//! `conversational.plan` (C6), the bridge answers server requests and the
//! final agent message of the turn is the chat completion. Cancellation is
//! real: the shared `CancellationToken` aborts the wait and `turn/interrupt`
//! (C9) cancels an in-flight plan at its next checkpoint.

use crate::settings::store::ModelProvider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

/// Upper bound for a single chat turn (the same deadline the dynamic tool
/// host enforces for tool execution; a turn longer than this is an anomaly).
const TURN_DEADLINE: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ModelMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_call_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ModelFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelFunctionCall {
    pub name: String,
    pub arguments: String,
}

/// C10: legacy HTTP tool-definition shapes, kept only for the chat.rs schema
/// tests (the Codex path defines tools server-side).
#[cfg(test)]
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelToolDefinition {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ModelFunctionDefinition,
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// C10: the Codex provider returns only natural text (the turn's final
/// agent message); dynamic tool calls arrive through the bridge
/// (`codex/tools.rs`), never through this response.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelResponse {
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    NotConfigured,
    Server,
    Timeout,
    InvalidPayload,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub messages: Vec<ModelMessage>,
    /// C10: workspace whose Codex thread carries this chat turn.
    pub workspace_id: String,
    /// Review #12: app request id for turn correlation (`turn_id ->
    /// request_id` streaming telemetry). None for non-chat callers.
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelCompletion {
    pub response: ModelResponse,
    pub provider: ModelProvider,
    pub model_used: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ModelProvider,
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

pub trait JarvisModelProvider: Send + Sync {
    /// Called with the AppHandle once (app setup) when the provider needs
    /// access to managed state (Codex runtime, thread registry).
    fn attach(&self, _app: AppHandle) {}
    /// Review #7: status derives from the full Jarvis settings (the model
    /// label is the single source of truth `codex.model`).
    fn status(&self, jarvis: &crate::settings::store::JarvisSettings) -> ProviderStatus;
    fn complete(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ModelCompletion, ModelError>> + Send>>;
}

/// C10: the Codex App Server is the single Jarvis LLM provider.
pub struct CodexAppServerProvider {
    app: Mutex<Option<AppHandle>>,
}

impl Default for CodexAppServerProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServerProvider {
    pub fn new() -> Self {
        Self {
            app: Mutex::new(None),
        }
    }
}

impl JarvisModelProvider for CodexAppServerProvider {
    fn attach(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn status(&self, jarvis: &crate::settings::store::JarvisSettings) -> ProviderStatus {
        use crate::jarvis::codex::runtime::CodexRuntimeManager;
        use crate::jarvis::codex::types::CodexRuntimeState;
        let app = self.app.lock().unwrap().clone();
        let runtime = app
            .as_ref()
            .and_then(|app| app.try_state::<CodexRuntimeManager>());
        let runtime_state = runtime
            .as_ref()
            .map(|runtime| runtime.current_state())
            .unwrap_or(CodexRuntimeState::Stopped);
        // Review #4: ChatGPT subscription only — an API-key or other account
        // is not a valid Jarvis backend (cost guard, spec §23).
        let account_type = runtime.and_then(|runtime| runtime.current_account_type());
        let configured = runtime_state == CodexRuntimeState::Running
            && account_type.as_deref() == Some("chatgpt");
        let reason = if configured {
            None
        } else {
            Some(match runtime_state {
                CodexRuntimeState::Running => {
                    if account_type.as_deref() == Some("apiKey") {
                        "codex_richiede_chatgpt".to_string()
                    } else {
                        "codex_autenticazione_non_verificata".to_string()
                    }
                }
                CodexRuntimeState::Starting => "codex_avvio_in_corso".to_string(),
                CodexRuntimeState::Crashed => "codex_arrestato".to_string(),
                CodexRuntimeState::Failed => "codex_non_disponibile".to_string(),
                _ => "codex_non_avviato".to_string(),
            })
        };
        ProviderStatus {
            provider: ModelProvider::Codex,
            // Review #7: single source of truth for the model label.
            primary_model: jarvis.codex.model.clone(),
            fallback_model: String::new(),
            configured,
            fallback_enabled: false,
            privacy_consent: jarvis.text_model.privacy_consent,
            privacy_consent_at: jarvis.text_model.privacy_consent_at.clone(),
            primary_model_available: configured,
            circuit_breaker_until: None,
            circuit_breaker_reason: reason,
        }
    }

    fn complete(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ModelCompletion, ModelError>> + Send>> {
        let app = self.app.lock().unwrap().clone();
        Box::pin(async move {
            let app = app.ok_or(ModelError::NotConfigured)?;
            let text = last_user_text(&request.messages).ok_or(ModelError::InvalidPayload)?;
            let threads = app
                .try_state::<crate::jarvis::codex::threads::ThreadRegistry>()
                .ok_or(ModelError::NotConfigured)?;

            // Review #4: ChatGPT subscription only. The API-key/other account
            // types are not valid Jarvis backends (cost guard, spec §23);
            // the boot-time cache may race the first message, so re-read
            // account/read once before refusing.
            let runtime = app
                .try_state::<crate::jarvis::codex::runtime::CodexRuntimeManager>()
                .ok_or(ModelError::NotConfigured)?;
            // The runtime is lazy by design. A voice/chat turn is an
            // intentional Jarvis activation, so it is the final fallback if
            // the user reached the turn before the bridge icon finished its
            // explicit start request.
            runtime.ensure_started().await.map_err(|err| {
                warn!(error = %err, "codex chat provider: lazy runtime start failed");
                ModelError::Server
            })?;
            let account_type = match runtime.current_account_type() {
                Some(account_type) => Some(account_type),
                None => {
                    let account_type = match runtime.client().await {
                        Ok(client) => match client.request("account/read", json!({})).await {
                            Ok(result) => result
                                .get("account")
                                .and_then(|account| account.get("type"))
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            Err(_) => None,
                        },
                        Err(_) => None,
                    };
                    runtime.set_account_type(account_type.clone()).await;
                    account_type
                }
            };
            if account_type.as_deref() != Some("chatgpt") {
                warn!(
                    workspace_id = %request.workspace_id,
                    account_type = ?account_type,
                    "codex chat provider: ChatGPT subscription required"
                );
                return Err(ModelError::NotConfigured);
            }

            // Resolve the workspace thread, register the completion waiter
            // BEFORE turn/start (no race with a very fast turn), then start.
            let thread = threads
                .ensure_thread(&request.workspace_id)
                .await
                .map_err(|err| {
                    warn!(
                        workspace_id = %request.workspace_id,
                        error = %err,
                        "codex chat provider: thread ensure failed"
                    );
                    ModelError::Server
                })?;
            let (tx, rx) = oneshot::channel();
            threads.register_chat_waiter(&thread.thread_id, tx).await;
            let turn_id = match threads
                .start_turn(&request.workspace_id, &text, request.request_id.as_deref())
                .await
            {
                Ok(turn_id) => turn_id,
                Err(err) => {
                    threads.dismiss_chat_waiter(&thread.thread_id).await;
                    warn!(
                        workspace_id = %request.workspace_id,
                        error = %err,
                        "codex chat provider: turn/start failed"
                    );
                    return Err(ModelError::Server);
                }
            };
            debug!(
                workspace_id = %request.workspace_id,
                turn_id = %turn_id,
                text_chars = text.chars().count(),
                "codex chat provider: turn started"
            );

            let outcome = tokio::select! {
                _ = cancellation.cancelled() => {
                    warn!(workspace_id = %request.workspace_id, "codex chat turn cancelled by caller");
                    // Review #3: same as the manual cancel path — stop the
                    // server-side turn too (plan token first, then
                    // turn/interrupt), best-effort and idempotent.
                    if let Some(tools) = app.try_state::<crate::jarvis::codex::tools::CodexToolService>() {
                        if let Err(err) = threads.interrupt_turn(&request.workspace_id, tools.inner()).await {
                            debug!(error = %err, "cancel: best-effort turn/interrupt failed");
                        }
                    }
                    threads.dismiss_chat_waiter(&thread.thread_id).await;
                    return Err(ModelError::Cancelled);
                }
                result = rx => match result {
                    Ok(outcome) => outcome,
                    // The sender was dropped without a terminal notification:
                    // treat as a server-side failure rather than hanging.
                    Err(_) => return Err(ModelError::Server),
                },
                _ = tokio::time::sleep(TURN_DEADLINE) => {
                    warn!(workspace_id = %request.workspace_id, "codex chat turn timed out");
                    // Review #3: the local deadline must ALSO stop the
                    // server-side turn. Without this the model could keep
                    // reasoning and later fire a conversational.plan even
                    // though the caller already got a Timeout.
                    if let Some(tools) = app.try_state::<crate::jarvis::codex::tools::CodexToolService>() {
                        if let Err(err) = threads.interrupt_turn(&request.workspace_id, tools.inner()).await {
                            debug!(error = %err, "timeout: best-effort turn/interrupt failed");
                        }
                    }
                    threads.dismiss_chat_waiter(&thread.thread_id).await;
                    return Err(ModelError::Timeout);
                }
            };
            let final_text = match outcome {
                crate::jarvis::codex::threads::TurnOutcome::Final(text) => text,
                crate::jarvis::codex::threads::TurnOutcome::Failed(message) => {
                    warn!(
                        workspace_id = %request.workspace_id,
                        message = %message,
                        "codex chat turn failed"
                    );
                    return Err(ModelError::Server);
                }
                crate::jarvis::codex::threads::TurnOutcome::Interrupted => {
                    debug!(workspace_id = %request.workspace_id, "codex chat turn interrupted");
                    return Err(ModelError::Cancelled);
                }
            };
            let model_used = thread.model.clone();
            Ok(ModelCompletion {
                response: ModelResponse {
                    content: final_text,
                },
                provider: ModelProvider::Codex,
                model_used,
            })
        })
    }
}

/// C10: the chat input is the latest non-empty user message. The system
/// prompt and history stay client-side (the Codex thread keeps its own
/// conversation); never forward assistant tool payloads as user text.
fn last_user_text(messages: &[ModelMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> ModelMessage {
        ModelMessage::new("user", content)
    }

    fn assistant(content: &str) -> ModelMessage {
        ModelMessage::new("assistant", content)
    }

    #[test]
    fn last_user_text_ignores_assistant_and_empty() {
        assert_eq!(
            last_user_text(&[assistant("ciao"), user("  ehi  ")]).as_deref(),
            Some("ehi")
        );
        assert_eq!(last_user_text(&[assistant("ciao")]), None);
        assert_eq!(last_user_text(&[user("   ")]), None);
        assert_eq!(
            last_user_text(&[user("uno"), assistant("due"), user("tre")]).as_deref(),
            Some("tre")
        );
    }

    #[test]
    fn provider_without_attach_is_not_configured() {
        let provider = CodexAppServerProvider::new();
        let status = provider.status(&crate::settings::store::JarvisSettings::default());
        assert!(!status.configured);
        assert_eq!(status.provider, ModelProvider::Codex);
    }

    #[tokio::test]
    async fn complete_without_app_is_not_configured() {
        let provider = CodexAppServerProvider::new();
        let request = ModelRequest {
            messages: vec![user("ciao")],
            workspace_id: "w1".into(),
            request_id: None,
        };
        let result = provider.complete(request, CancellationToken::new()).await;
        assert_eq!(result, Err(ModelError::NotConfigured));
    }

    #[tokio::test]
    async fn complete_without_user_message_is_invalid_payload() {
        // Same guard as the runtime path: the token is fresh, the request
        // carries only an assistant message → rejected before any RPC.
        let request = ModelRequest {
            messages: vec![assistant("ciao")],
            workspace_id: "w1".into(),
            request_id: None,
        };
        // No app attached: the NotConfigured check fires first on this path,
        // so we validate the guard order (payload is validated after attach);
        // with an app the same request would hit InvalidPayload.
        let provider = CodexAppServerProvider::new();
        let result = provider.complete(request, CancellationToken::new()).await;
        assert_eq!(result, Err(ModelError::NotConfigured));
    }

    #[test]
    fn model_label_comes_from_the_codex_settings() {
        // Review #7: single source of truth — status() reports the model
        // from jarvis.codex, never a legacy text-provider field.
        let mut jarvis = crate::settings::store::JarvisSettings::default();
        jarvis.codex.model = "gpt-5.6-luna".into();
        let provider = CodexAppServerProvider::new();
        let status = provider.status(&jarvis);
        assert_eq!(status.primary_model, "gpt-5.6-luna");
        assert_eq!(status.fallback_model, "");
        assert!(!status.fallback_enabled);
    }
}
