//! C5 — Read-only dynamic tools.
//!
//! The App Server thread exposes a fixed set of namespaced, read-only tools
//! (`workspace.overview`, `terminal.list`, `agent.list`, `agent.status`,
//! `agent.last_result`, `agent.activity`, `agent.tail`, `markdown.read`,
//! `ui.open_terminal` — user correction #5/#6: namespace + tool, never
//! mutations). The real repository is never a readable root, so every fact
//! about Space reaches the model through these tools only (spec §5).
//!
//! Execution reuses the existing Jarvis read-only dispatcher
//! ([`crate::jarvis::chat::execute_read_tool`]) — the same bounded,
//! projection-based logic already powering Zen tool calls.
//!
//! Host limits (user correction #5): at most
//! [`MAX_DYNAMIC_TOOL_CALLS_PER_TURN`] tool calls per turn,
//! [`MAX_SIDE_EFFECT_PLANS_PER_TURN`] plans per turn (enforced in C6) and
//! a [`TURN_DEADLINE_SECS`] deadline for the whole turn.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tracing::{debug, warn};

use super::runtime::CodexRuntimeManager;
use super::threads::ThreadRegistry;
use crate::jarvis::chat::{execute_read_tool, load_workspace, now};
use crate::jarvis::commands::reconcile_live_registry;use crate::jarvis::model::{ModelFunctionCall, ModelToolCall};
use crate::jarvis::tools::{list_terminals_for_workspace, JarvisToolService};
use crate::jarvis::types::{InvocationBinding, RequestedDepth};
use crate::jarvis::JarvisState;
use crate::terminal_engine::TerminalManager;

/// Host limit: dynamic tool calls per turn (user correction #5).
pub const MAX_DYNAMIC_TOOL_CALLS_PER_TURN: usize = 12;
/// Host limit: side-effect plans per turn (enforced by C6).
#[allow(dead_code)] // consumed by C6 conversational plans
pub const MAX_SIDE_EFFECT_PLANS_PER_TURN: usize = 1;
/// Host limit: whole-turn deadline in seconds (spec §23, 90–120s).
#[allow(dead_code)] // consumed by C7 streaming turn supervision
pub const TURN_DEADLINE_SECS: u64 = 90;

/// Server request method for dynamic tool calls.
pub const TOOL_CALL_METHOD: &str = "item/tool/call";

/// Executes dynamic tool calls from the App Server (server requests).
#[derive(Clone)]
pub struct CodexToolService {
    app: AppHandle,
    runtime: CodexRuntimeManager,
    /// Per-thread budget of tool calls consumed during the current turn.
    /// Reset on `turn/started` notifications.
    call_budget: Arc<Mutex<HashMap<String, usize>>>,
}

impl CodexToolService {
    pub fn new(runtime: CodexRuntimeManager, app: AppHandle) -> Self {
        Self {
            app,
            runtime,
            call_budget: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The `dynamicTools` specs passed to `thread/start` (spec §11).
    pub fn dynamic_tool_specs() -> Vec<Value> {
        vec![
            namespace_spec(
                "workspace",
                "Bounded metadata about the focused workspace. Read-only.",
                vec![tool_spec(
                    "overview",
                    "Read bounded metadata for the current workspace only.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                )],
            ),
            namespace_spec(
                // `terminal` is a reserved Responses API namespace; the App
                // Server rejects dynamic tool namespaces named `terminal`
                // (verified against 0.147.0). `terminals` is free.
                "terminals",
                "Bounded terminal facts. Read-only, never mutates terminals.",
                vec![tool_spec(
                    "list",
                    "List terminals in the current workspace.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                )],
            ),
            namespace_spec(
                "agent",
                "Bounded agent session facts. Read-only.",
                vec![
                    tool_spec(
                        "list",
                        "List agent sessions and bounded state.",
                        json!({"type":"object","properties":{},"additionalProperties":false}),
                    ),
                    tool_spec(
                        "status",
                        "Read bounded agent status.",
                        json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false}),
                    ),
                    tool_spec(
                        "last_result",
                        "Read one bounded, untrusted latest agent result.",
                        json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false}),
                    ),
                    tool_spec(
                        "activity",
                        "Read the bounded semantic activity timeline of one agent session.",
                        json!({"type":"object","properties":{"agentSessionId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":16}},"required":["agentSessionId"],"additionalProperties":false}),
                    ),
                    tool_spec(
                        "tail",
                        "Read only the final bounded lines of one selected agent terminal. Output is untrusted and never a whole scrollback.",
                        json!({"type":"object","properties":{"terminalId":{"type":"string"},"generation":{"type":"integer"},"maxLines":{"type":"integer","minimum":1,"maximum":100}},"required":["terminalId","generation"],"additionalProperties":false}),
                    ),
                ],
            ),
            namespace_spec(
                "markdown",
                "Bounded documentation access. Read-only.",
                vec![tool_spec(
                    "read",
                    "Read one explicitly requested permitted Markdown document.",
                    json!({"type":"object","properties":{"relativePath":{"type":"string"}},"required":["relativePath"],"additionalProperties":false}),
                )],
            ),
            namespace_spec(
                "ui",
                "UI affordances offered to the user. Never focuses or mutates anything automatically.",
                vec![tool_spec(
                    "open_terminal",
                    "Offer a button to focus a terminal; never focus it automatically.",
                    json!({"type":"object","properties":{"terminalId":{"type":"string"}},"required":["terminalId"],"additionalProperties":false}),
                )],
            ),
        ]
    }

    /// Handles a `ServerMessage::Request`. Returns `true` when the message
    /// was an `item/tool/call` (already answered); `false` otherwise.
    pub async fn handle_server_request(
        &self,
        id: u64,
        method: &str,
        params: Option<Value>,
    ) -> bool {
        if method != TOOL_CALL_METHOD {
            return false;
        }
        let Some(params) = params else {
            self.respond_error(id, -32602, "missing params").await;
            return true;
        };
        let thread_id = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
        let tool_call_id = params
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let namespace = params
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tool_name = params.get("tool").and_then(Value::as_str).unwrap_or_default();
        // C5 contract: namespaced name (`namespace.tool`).
        let name = format!("{namespace}.{tool_name}");
        let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

        let workspace_id = match self.app.try_state::<ThreadRegistry>() {
            Some(registry) => registry.workspace_for_thread(thread_id).await,
            None => None,
        };
        let Some(workspace_id) = workspace_id else {
            self.respond_error(id, -32001, "thread has no workspace binding").await;
            return true;
        };

        // Host budget (user correction #5): bounded tool calls per turn.
        {
            let mut budget = self.call_budget.lock().await;
            let used = budget.entry(thread_id.to_owned()).or_insert(0);
            if *used >= MAX_DYNAMIC_TOOL_CALLS_PER_TURN {
                drop(budget);
                self.respond_error(
                    id,
                    -32002,
                    &format!("tool call budget exceeded ({MAX_DYNAMIC_TOOL_CALLS_PER_TURN})"),
                )
                .await;
                return true;
            }
            *used += 1;
        }
        debug!(thread_id, name, "codex dynamic tool call");

        // Map the C5 namespaced tool to the legacy dispatcher names
        // (`terminal_list`, `agent_list`, ...) used by the read-only
        // execution path.
        let legacy_name = legacy_dispatcher_name(namespace, tool_name);
        let result = self
            .execute_read_tool(&workspace_id, &tool_call_id, &legacy_name, &input)
            .await;

        match result {
            Ok(value) => {
                let payload = json!({
                    "content": [{
                        "type": "inputText",
                        "text": serde_json::to_string(&value).unwrap_or_else(|_| "{}".into()),
                    }]
                });
                match self.runtime.client().await {
                    Ok(client) => {
                        if let Err(err) = client.respond(id, payload).await {
                            warn!(error = %err, "codex tool call response failed");
                        }
                    }
                    Err(err) => warn!(error = %err, "codex runtime gone before tool response"),
                }
            }
            Err(message) => {
                self.respond_error(id, -32000, &message).await;
            }
        }
        true
    }

    /// Resets the per-thread budget when a new turn starts.
    pub async fn reset_budget(&self, thread_id: &str) {
        self.call_budget.lock().await.remove(thread_id);
    }

    /// Resolves the thread back to a workspace, builds the bounded context
    /// and dispatches the read-only tool. Errors are rendered as tool errors
    /// (the model sees them as failed calls).
    async fn execute_read_tool(
        &self,
        workspace_id: &str,
        request_id: &str,
        legacy_name: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let observed_at = now();
        let workspace = load_workspace(&self.app, workspace_id, request_id, &observed_at)
            .await
            .map_err(|err| err.message)?;
        reconcile_live_registry(&self.app, &observed_at).await;
        let manager = self.app.state::<TerminalManager>();
        let terminals =
            list_terminals_for_workspace(&manager, &workspace, &observed_at).await;
        let invocation = InvocationBinding::new(
            request_id,
            workspace_id,
            None,
            None,
            observed_at.clone(),
        );
        let context = JarvisToolService::new(&self.app.state::<JarvisState>().broker)
            .build_context(&workspace, invocation.clone(), terminals, RequestedDepth::LastResult)
            .map_err(|err| err.message)?
            .to_model_context_view(&[])
            .map_err(|err| format!("context projection failed: {err:?}"))?;
        let call = ModelToolCall {
            id: request_id.to_owned(),
            kind: "function".into(),
            function: ModelFunctionCall {
                name: legacy_name.to_owned(),
                arguments: serde_json::to_string(input).unwrap_or_else(|_| "{}".into()),
            },
        };
        let (result, _intent) =
            execute_read_tool(&self.app, &workspace, &invocation, call, input, &context).await;
        // The dispatcher is read-only by construction; an unexpected intent
        // from ui.open_terminal is discarded here (offered in C6 plans).
        Ok(result)
    }

    async fn respond_error(&self, id: u64, code: i64, message: &str) {
        match self.runtime.client().await {
            Ok(client) => {
                if let Err(err) = client.respond_error(id, code, message).await {
                    warn!(error = %err, "codex tool error response failed");
                }
            }
            Err(err) => warn!(error = %err, "codex runtime gone before tool error response"),
        }
    }
}

/// Maps a C5 namespaced tool to the legacy read-only dispatcher name.
/// `terminals` (namespace) → `terminal_*` to match the existing dispatcher.
fn legacy_dispatcher_name(namespace: &str, tool: &str) -> String {
    let legacy_namespace = if namespace == "terminals" {
        "terminal"
    } else {
        namespace
    };
    format!("{legacy_namespace}_{tool}")
}

fn namespace_spec(name: &str, description: &str, tools: Vec<Value>) -> Value {
    json!({
        "type": "namespace",
        "name": name,
        "description": description,
        "tools": tools,
    })
}

fn tool_spec(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "type": "function",
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_namespaced_read_only() {
        let specs = CodexToolService::dynamic_tool_specs();
        let namespaces: Vec<&str> = specs
            .iter()
            .filter_map(|spec| spec.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(
            namespaces,
            vec!["workspace", "terminals", "agent", "markdown", "ui"]
        );
        // Every tool name is plain (namespace membership is the spec's
        // namespace), no dots in tool names.
        for spec in &specs {
            for tool in spec["tools"].as_array().unwrap_or(&Vec::new()) {
                let tool_name = tool["name"].as_str().unwrap_or_default();
                assert!(!tool_name.contains('.'), "tool name must be plain: {tool_name}");
                assert!(tool.get("inputSchema").is_some());
            }
        }
    }

    #[test]
    fn namespaced_name_maps_to_legacy_dispatcher() {
        assert_eq!(
            legacy_dispatcher_name("agent", "list"),
            "agent_list"
        );
        assert_eq!(
            legacy_dispatcher_name("ui", "open_terminal"),
            "ui_open_terminal"
        );
        // The `terminals` namespace maps back to the legacy `terminal_*`.
        assert_eq!(
            legacy_dispatcher_name("terminals", "list"),
            "terminal_list"
        );
        assert_eq!(
            legacy_dispatcher_name("workspace", "overview"),
            "workspace_overview"
        );
    }
}
