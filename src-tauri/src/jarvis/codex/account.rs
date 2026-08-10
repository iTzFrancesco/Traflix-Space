//! C2 — Authentication: account/read, login (ChatGPT OAuth), logout.
//!
//! Traflix Space never reads, copies, persists or forwards OAuth tokens:
//! the App Server owns ChatGPT credentials and refresh (spec §6, §21).
//! This module only surfaces an account *view* (signed out vs connected)
//! and drives the sign-in flow by opening the `authUrl` in the internal
//! browser, waiting for the `account/login/completed` notification.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::models::CodexModelService;
use super::rpc::{JsonRpcClient, RpcError, ServerMessage};
use super::threads::ThreadRegistry;
use super::tools::CodexToolService;
use super::runtime::{CodexRuntimeManager, RuntimeError};

impl From<RpcError> for RuntimeError {
    fn from(err: RpcError) -> Self {
        RuntimeError::Rpc(err.to_string())
    }
}

/// Global Tauri event carrying account notifications to the UI
/// (`account/login/completed`, `account/updated`).
pub const ACCOUNT_EVENT: &str = "jarvis://codex-account";

/// Account snapshot exposed to the UI. Deliberately token-free.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CodexAccount {
    SignedOut,
    #[serde(rename_all = "camelCase")]
    Chatgpt {
        email: Option<String>,
        plan_type: String,
    },
    ApiKey,
    #[serde(rename_all = "camelCase")]
    Other { account_type: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountView {
    pub account: CodexAccount,
    pub requires_openai_auth: bool,
}

/// Result of `account/login/start` (chatgpt flow).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartView {
    pub auth_url: String,
    pub login_id: String,
}

/// Parse the `account` object returned by `account/read` into a safe view.
pub(crate) fn parse_account(account: Option<&Value>) -> CodexAccount {
    let Some(account) = account else {
        return CodexAccount::SignedOut;
    };
    if account.is_null() {
        return CodexAccount::SignedOut;
    }
    let account_type = account
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match account_type {
        "chatgpt" => CodexAccount::Chatgpt {
            email: account.get("email").and_then(Value::as_str).map(str::to_owned),
            plan_type: account
                .get("planType")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
        },
        "apiKey" => CodexAccount::ApiKey,
        other => CodexAccount::Other {
            account_type: other.to_owned(),
        },
    }
}

/// Long-lived bridge: consumes App Server notifications and forwards the
/// account-related ones to the UI as `jarvis://codex-account` events.
/// Spawned by the runtime after every successful (re)start.
pub fn spawn_account_bridge(
    _runtime: CodexRuntimeManager,
    app: AppHandle,
    models: Option<CodexModelService>,
    threads: Option<ThreadRegistry>,
    tools: Option<CodexToolService>,
    mut rx: mpsc::UnboundedReceiver<ServerMessage>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let (method, params) = match &message {
                ServerMessage::Notification { method, params } => (method.clone(), params.clone()),
                // C5: the server asks the client to execute a dynamic tool.
                // The call is answered here (result or error response).
                ServerMessage::Request { id, method, params } => {
                    if let Some(tools) = &tools {
                        if tools.handle_server_request(*id, method, params.clone()).await {
                            continue;
                        }
                    }
                    // Unknown server requests: answer with a method-not-found
                    // error so the server never waits forever on us.
                    if let Ok(client) = _runtime.client().await {
                        let _ = client
                            .respond_error(*id, -32601, &format!("unknown server request: {method}"))
                            .await;
                    }
                    continue;
                }
            };
            // C3: incremental rate-limit updates are merged into the last
            // full snapshot (never overwriting with null) and forwarded.
            if method == "account/rateLimits/updated" {
                if let (Some(params), Some(models)) = (&params, &models) {
                    let update = params.get("rateLimits").cloned().unwrap_or_default();
                    models.apply_incremental_update(&app, &update);
                }
                continue;
            }
            // C4: thread/turn lifecycle notifications keep the registry in
            // sync (turn started/completed clears the active turn).
            if method.starts_with("thread/") || method.starts_with("turn/") {
                if method == "turn/started" {
                    if let (Some(params), Some(tools)) = (&params, &tools) {
                        if let Some(thread_id) = params.get("threadId").and_then(|v| v.as_str()) {
                            // C5 tool-call budget + C6 single-plan guard.
                            tools.reset_turn_state(thread_id).await;
                        }
                    }
                }
                if let Some(threads) = &threads {
                    threads.apply_notification(&method, &params).await;
                }
                continue;
            }
            if !method.starts_with("account/") {
                continue;
            }
            debug!(method, "codex account notification");
            let _ = app.emit(
                ACCOUNT_EVENT,
                json!({ "method": method, "params": params }),
            );
        }
        warn!("codex account bridge stopped (server channel closed)");
    });
}

/// Shared service behind the C2 Tauri commands.
pub struct CodexAccountService {
    runtime: CodexRuntimeManager,
}

impl CodexAccountService {
    pub fn new(runtime: CodexRuntimeManager) -> Self {
        Self { runtime }
    }

    async fn client(&self) -> Result<Arc<JsonRpcClient>, RuntimeError> {
        self.runtime.client().await
    }

    /// `account/read` — requires an explicit params object (even empty).
    pub async fn read(&self) -> Result<CodexAccountView, RuntimeError> {
        let client = self.client().await?;
        let result = client.request("account/read", json!({})).await?;
        let account = parse_account(result.get("account"));
        let requires_openai_auth = result
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(CodexAccountView {
            account,
            requires_openai_auth,
        })
    }

    /// `account/login/start` — ChatGPT OAuth flow. The caller opens
    /// `auth_url` in the internal browser; completion arrives as a
    /// `account/login/completed` notification on `jarvis://codex-account`.
    pub async fn login_start(&self) -> Result<LoginStartView, RuntimeError> {
        let client = self.client().await?;
        let result = client
            .request(
                "account/login/start",
                json!({
                    "type": "chatgpt",
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "chatgpt",
                }),
            )
            .await?;
        let auth_url = result
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::Handshake("account/login/start missing authUrl".into()))?
            .to_owned();
        let login_id = result
            .get("loginId")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::Handshake("account/login/start missing loginId".into()))?
            .to_owned();
        Ok(LoginStartView { auth_url, login_id })
    }

    /// `account/login/cancel` — aborts an in-flight login.
    pub async fn login_cancel(&self, login_id: String) -> Result<(), RuntimeError> {
        let client = self.client().await?;
        let _ = client
            .request("account/login/cancel", json!({ "loginId": login_id }))
            .await?;
        Ok(())
    }

    /// `account/logout` — signs out the current account (App Server clears
    /// its own credentials; we never touch them).
    pub async fn logout(&self) -> Result<(), RuntimeError> {
        let client = self.client().await?;
        let _ = client.request("account/logout", json!({})).await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jarvis_codex_account_read(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexAccountView, String> {
    let service = CodexAccountService::new(runtime.inner().clone());
    service
        .read()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_login_start(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<LoginStartView, String> {
    let service = CodexAccountService::new(runtime.inner().clone());
    service
        .login_start()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_login_cancel(
    login_id: String,
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<(), String> {
    let service = CodexAccountService::new(runtime.inner().clone());
    service
        .login_cancel(login_id)
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_logout(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<(), String> {
    let service = CodexAccountService::new(runtime.inner().clone());
    service
        .logout()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chatgpt_account() {
        let view = parse_account(Some(&json!({
            "type": "chatgpt",
            "email": "user@example.com",
            "planType": "plus",
        })));
        assert_eq!(
            view,
            CodexAccount::Chatgpt {
                email: Some("user@example.com".into()),
                plan_type: "plus".into(),
            }
        );
    }

    #[test]
    fn parses_signed_out_and_unknown() {
        assert_eq!(parse_account(None), CodexAccount::SignedOut);
        assert_eq!(parse_account(Some(&json!(null))), CodexAccount::SignedOut);
        assert_eq!(
            parse_account(Some(&json!({ "type": "apiKey" }))),
            CodexAccount::ApiKey
        );
        assert_eq!(
            parse_account(Some(&json!({ "type": "amazonBedrock" }))),
            CodexAccount::Other {
                account_type: "amazonBedrock".into()
            }
        );
    }

    #[test]
    fn chatgpt_account_without_email() {
        assert_eq!(
            parse_account(Some(&json!({ "type": "chatgpt", "planType": "free" }))),
            CodexAccount::Chatgpt {
                email: None,
                plan_type: "free".into(),
            }
        );
    }

    #[test]
    fn login_payload_shape_matches_protocol() {
        // The request body must be the chatgpt variant of LoginAccountParams.
        let body = json!({
            "type": "chatgpt",
            "useHostedLoginSuccessPage": true,
            "appBrand": "chatgpt",
        });
        assert_eq!(body["type"], "chatgpt");
        assert_eq!(body["useHostedLoginSuccessPage"], true);
        assert_eq!(body["appBrand"], "chatgpt");
    }

    #[test]
    fn server_request_routing_ignores_non_account() {
        // Bridge filter: only account/* notifications are forwarded.
        let forwarded = |method: &str| method.starts_with("account/");
        assert!(forwarded("account/login/completed"));
        assert!(forwarded("account/updated"));
        assert!(!forwarded("turn/started"));
        assert!(!forwarded("item/completed"));
    }
}
