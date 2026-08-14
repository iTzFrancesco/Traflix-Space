//! C2 — Authentication + App Server notification bridge.
//!
//! Traflix Space never reads, copies, persists or forwards OAuth tokens:
//! Codex App Server owns ChatGPT credentials and refresh. This module only
//! surfaces a token-free account view, starts ChatGPT OAuth, and routes App
//! Server account/turn/item notifications to Jarvis state.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::events::{stream_events_from_notification, CHAT_STREAM_EVENT};
use super::models::CodexModelService;
use super::rpc::{JsonRpcClient, RpcError, ServerMessage};
use super::runtime::{CodexRuntimeManager, RuntimeError};
use super::threads::{ThreadRegistry, TurnOutcome};
use super::tools::CodexToolService;

impl From<RpcError> for RuntimeError {
    fn from(err: RpcError) -> Self {
        RuntimeError::Rpc(err.to_string())
    }
}

/// Global Tauri event carrying account notifications to the UI.
pub const ACCOUNT_EVENT: &str = "jarvis://codex-account";

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
    Other {
        account_type: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountView {
    pub account: CodexAccount,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartView {
    pub auth_url: String,
    pub login_id: String,
}

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
            email: account
                .get("email")
                .and_then(Value::as_str)
                .map(str::to_owned),
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

fn raw_account_type(account: Option<&Value>) -> Option<String> {
    account?
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

async fn emit_chat_stream(
    app: &AppHandle,
    threads: &ThreadRegistry,
    method: &str,
    params: &Option<Value>,
) {
    let Some(params) = params.as_ref() else {
        return;
    };
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if thread_id.is_empty() {
        return;
    }
    let Some(workspace_id) = threads.workspace_for_thread(thread_id).await else {
        debug!(
            thread_id,
            method, "codex streaming: thread has no workspace binding"
        );
        return;
    };
    let turn_id = super::events::turn_id_of(params);
    let request_id = if turn_id.is_empty() {
        None
    } else {
        threads.request_id_for_turn(&turn_id).await
    };
    let events = stream_events_from_notification(
        method,
        &Some(params.clone()),
        &workspace_id,
        request_id.as_deref(),
    );
    for event in events {
        let _ = app.emit(CHAT_STREAM_EVENT, event);
    }
}

/// Extracts a completed agent message. Current App Server uses
/// `{ type: "agentMessage", text: "..." }`; content blocks are kept as a
/// compatibility fallback for the pinned 0.147.x runtime.
fn agent_message_text(item: &Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return None;
    }

    if let Some(text) = item.get("text").and_then(Value::as_str) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_owned());
        }
    }

    let content = item.get("content").and_then(Value::as_array)?;
    let parts: Vec<String> = content
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

fn final_message_text(params: &Value) -> Option<String> {
    params.get("item").and_then(agent_message_text)
}

/// Fallback for a server that includes final turn items in turn/completed.
/// The last completed agentMessage is authoritative for the user-visible
/// final answer when no earlier item/completed was captured.
fn turn_final_message_text(params: &Value) -> Option<String> {
    params
        .get("turn")
        .and_then(|turn| turn.get("items"))
        .and_then(Value::as_array)
        .and_then(|items| items.iter().rev().find_map(agent_message_text))
}

async fn capture_final_message_text(threads: &ThreadRegistry, params: &Value) {
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let Some(text) = final_message_text(params) else {
        return;
    };
    threads.set_last_message_text(thread_id, text).await;
}

async fn capture_turn_final_fallback(threads: &ThreadRegistry, params: &Value) {
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    if let Some(text) = turn_final_message_text(params) {
        threads.set_last_message_text(thread_id, text).await;
    }
}

fn turn_status(params: &Value) -> Option<&str> {
    params
        .get("turn")
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .or_else(|| params.get("status").and_then(Value::as_str))
}

fn turn_error_message(params: &Value) -> String {
    let error = params
        .get("turn")
        .and_then(|turn| turn.get("error"))
        .or_else(|| params.get("error"));
    match error {
        Some(Value::String(message)) if !message.trim().is_empty() => message.clone(),
        Some(Value::Object(object)) => object
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or("turn failed")
            .to_owned(),
        _ => "turn failed".to_owned(),
    }
}

pub fn spawn_account_bridge(
    runtime: CodexRuntimeManager,
    app: AppHandle,
    client: Arc<JsonRpcClient>,
    models: Option<CodexModelService>,
    threads: Option<ThreadRegistry>,
    tools: Option<CodexToolService>,
    mut rx: mpsc::UnboundedReceiver<ServerMessage>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let (method, params) = match &message {
                ServerMessage::Notification { method, params } => (method.clone(), params.clone()),
                ServerMessage::Request { id, method, params } => {
                    // Never block the App Server channel loop on a tool.
                    // Independent tool calls proceed in parallel and this
                    // bridge keeps draining streaming notifications. Tool
                    // execution owns its own deadline; response JSONL writes
                    // are never cancelled by this bridge.
                    info!(
                        method,
                        id = *id,
                        "codex rpc server request received (dispatched async)",
                    );
                    if let Some(tools) = &tools {
                        let tools = tools.for_server_client(Arc::clone(&client));
                        let client = Arc::clone(&client);
                        let method = method.clone();
                        let params = params.clone();
                        let id = *id;
                        tauri::async_runtime::spawn(async move {
                            if tools.handle_server_request(id, &method, params).await {
                                return;
                            }
                            let _ = client
                                .respond_error(
                                    id,
                                    -32601,
                                    &format!("unknown server request: {method}"),
                                )
                                .await;
                        });
                    } else {
                        let _ = client
                            .respond_error(
                                *id,
                                -32601,
                                &format!("unknown server request: {method}"),
                            )
                            .await;
                    }
                    continue;
                }
            };

            if method == "account/rateLimits/updated" {
                if let (Some(params), Some(models)) = (&params, &models) {
                    let update = params.get("rateLimits").cloned().unwrap_or_default();
                    models.apply_incremental_update(&app, &update);
                }
                continue;
            }

            if method.starts_with("thread/") || method.starts_with("turn/") {
                if method == "turn/started" {
                    if let (Some(params), Some(tools)) = (&params, &tools) {
                        if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                            tools.reset_turn_state(thread_id).await;
                        }
                    }
                }

                if let Some(threads) = &threads {
                    let terminal = matches!(
                        method.as_str(),
                        "turn/completed" | "turn/failed" | "turn/interrupted"
                    );
                    if terminal {
                        let terminal_matches = if let Some(value) = params.as_ref() {
                            if let Some(thread_id) = value.get("threadId").and_then(Value::as_str) {
                                let turn_id = super::events::turn_id_of(value);
                                !turn_id.is_empty()
                                    && threads.terminal_turn_matches(thread_id, &turn_id).await
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        if !terminal_matches {
                            // A late or identity-less terminal notification
                            // must not emit events or resolve the current
                            // request waiter.
                            continue;
                        }
                        if let (Some(params), Some(tools)) = (&params, &tools) {
                            if let Some(thread_id) = params.get("threadId").and_then(Value::as_str)
                            {
                                let turn_id = super::events::turn_id_of(params);
                                tools.clear_plan_cancel(thread_id, &turn_id).await;
                            }
                        }
                        // Read the request mapping before apply_notification
                        // removes the completed turn from the registry.
                        emit_chat_stream(&app, threads, &method, &params).await;
                        if let Some(params) = params.as_ref() {
                            if method == "turn/completed" {
                                capture_turn_final_fallback(threads, params).await;
                            }
                            if let Some(thread_id) = params.get("threadId").and_then(Value::as_str)
                            {
                                match method.as_str() {
                                    "turn/completed" => match turn_status(params) {
                                        Some("failed") => {
                                            threads
                                                .fail_chat_waiter(
                                                    thread_id,
                                                    TurnOutcome::Failed(turn_error_message(params)),
                                                )
                                                .await;
                                        }
                                        Some("interrupted") => {
                                            threads
                                                .fail_chat_waiter(
                                                    thread_id,
                                                    TurnOutcome::Interrupted,
                                                )
                                                .await;
                                        }
                                        _ => threads.complete_chat_waiter(thread_id).await,
                                    },
                                    "turn/failed" => {
                                        threads
                                            .fail_chat_waiter(
                                                thread_id,
                                                TurnOutcome::Failed(turn_error_message(params)),
                                            )
                                            .await;
                                    }
                                    "turn/interrupted" => {
                                        threads
                                            .fail_chat_waiter(thread_id, TurnOutcome::Interrupted)
                                            .await;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        threads.apply_notification(&method, &params).await;
                    } else {
                        threads.apply_notification(&method, &params).await;
                        if method.starts_with("turn/") {
                            emit_chat_stream(&app, threads, &method, &params).await;
                        }
                    }
                }
                continue;
            }

            if method.starts_with("item/")
                || method == "AgentMessageDelta"
                || method == "AgentMessageThreadItem"
            {
                if let Some(threads) = &threads {
                    let Some(value) = params.as_ref() else {
                        continue;
                    };
                    let Some(thread_id) = value.get("threadId").and_then(Value::as_str) else {
                        continue;
                    };
                    let turn_id = super::events::turn_id_of(value);
                    if turn_id.is_empty() || !threads.active_turn_matches(thread_id, &turn_id).await
                    {
                        // Item notifications are also turn-scoped. Dropping
                        // stale items prevents a timed-out turn from
                        // repopulating the final-text buffer of a newer one.
                        continue;
                    }
                    emit_chat_stream(&app, threads, &method, &params).await;
                    if method == "item/completed" || method == "AgentMessageThreadItem" {
                        capture_final_message_text(threads, value).await;
                    }
                }
                continue;
            }

            if !method.starts_with("account/") {
                continue;
            }

            if method == "account/updated" {
                let account_type = params
                    .as_ref()
                    .and_then(|params| params.get("account"))
                    .and_then(|account| raw_account_type(Some(account)));
                runtime.set_account_type(account_type).await;
            }

            debug!(method, "codex account notification");
            let _ = app.emit(ACCOUNT_EVENT, json!({ "method": method, "params": params }));
        }
        warn!("codex account bridge stopped (server channel closed)");
    });
}

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

    pub async fn read(&self) -> Result<CodexAccountView, RuntimeError> {
        let client = self.client().await?;
        let result = client.request("account/read", json!({})).await?;
        let account_value = result.get("account");
        let account = parse_account(account_value);
        self.runtime
            .set_account_type(raw_account_type(account_value))
            .await;
        let requires_openai_auth = result
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(CodexAccountView {
            account,
            requires_openai_auth,
        })
    }

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

    pub async fn login_cancel(&self, login_id: String) -> Result<(), RuntimeError> {
        let client = self.client().await?;
        let _ = client
            .request("account/login/cancel", json!({ "loginId": login_id }))
            .await?;
        Ok(())
    }

    pub async fn logout(&self) -> Result<(), RuntimeError> {
        let client = self.client().await?;
        let _ = client.request("account/logout", json!({})).await?;
        self.runtime.set_account_type(None).await;
        Ok(())
    }
}

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
    fn canonical_agent_message_text_is_captured() {
        let text = final_message_text(&json!({
            "threadId": "t1",
            "turnId": "tu1",
            "item": {
                "id": "i1",
                "type": "agentMessage",
                "text": "Fatto."
            }
        }));
        assert_eq!(text.as_deref(), Some("Fatto."));
    }

    #[test]
    fn legacy_content_blocks_are_joined() {
        let text = final_message_text(&json!({
            "threadId": "t1",
            "item": {
                "type": "agentMessage",
                "content": [
                    { "type": "outputText", "text": "Prima parte." },
                    { "type": "outputText", "text": "  Seconda parte.  " }
                ]
            }
        }));
        assert_eq!(text.as_deref(), Some("Prima parte.\n\nSeconda parte."));
    }

    #[test]
    fn turn_completed_fallback_uses_last_agent_message() {
        let text = turn_final_message_text(&json!({
            "threadId": "t1",
            "turn": {
                "id": "tu1",
                "status": "completed",
                "items": [
                    { "id": "a", "type": "agentMessage", "text": "Prima" },
                    { "id": "tool", "type": "dynamicToolCall" },
                    { "id": "b", "type": "agentMessage", "text": "Finale" }
                ]
            }
        }));
        assert_eq!(text.as_deref(), Some("Finale"));
    }

    #[test]
    fn completed_turn_status_is_interpreted() {
        assert_eq!(
            turn_status(&json!({ "turn": { "status": "failed" } })),
            Some("failed")
        );
        assert_eq!(
            turn_status(&json!({ "turn": { "status": "interrupted" } })),
            Some("interrupted")
        );
    }

    #[test]
    fn non_agent_and_empty_messages_are_ignored() {
        assert_eq!(
            final_message_text(&json!({
                "item": { "type": "dynamicToolCall", "text": "ignore" }
            })),
            None
        );
        assert_eq!(
            final_message_text(&json!({
                "item": { "type": "agentMessage", "text": "   " }
            })),
            None
        );
    }
}
