//! C5/C6 — Dynamic tools (read-only + conversational control).
//!
//! The App Server thread exposes a fixed set of namespaced tools: read-only
//! ones (`workspace.overview`, `terminal.list`, `agent.list`, `agent.status`,
//! `agent.last_result`, `agent.activity`, `agent.tail`, `markdown.read`,
//! `ui.open_terminal` — user correction #5/#6: namespace + tool) and the
//! single side-effecting `conversational.plan` (C6, spec §12), which is
//! executed by the existing Rust [`crate::jarvis::control::execute_plan`]
//! and answered with its `ExecutionReceipt` in the same turn. The real
//! repository is never a readable root, so every fact about Space reaches
//! the model through these tools only (spec §5).
//!
//! Read-only execution reuses the existing Jarvis read-only dispatcher
//! ([`crate::jarvis::chat::execute_read_tool`]) — the same bounded,
//! projection-based logic already powering Zen tool calls. Every mutation
//! goes through `execute_plan`, never through any other tool.
//!
//! Host limits (user correction #5): at most
//! [`MAX_DYNAMIC_TOOL_CALLS_PER_TURN`] tool calls per turn,
//! [`MAX_SIDE_EFFECT_PLANS_PER_TURN`] plans per turn (spec §13) and
//! a [`TURN_DEADLINE_SECS`] deadline for the whole turn.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::runtime::CodexRuntimeManager;
use super::threads::ThreadRegistry;
use crate::jarvis::chat::{execute_read_tool, load_workspace, now};
use crate::jarvis::commands::reconcile_live_registry;use crate::jarvis::control::{conversational_plan_schema, execute_plan, ConversationalPlan};
use crate::jarvis::model::{ModelFunctionCall, ModelToolCall};
use crate::jarvis::tools::{list_terminals_for_workspace, JarvisToolService};
use crate::jarvis::types::{InvocationBinding, RequestedDepth};
use crate::jarvis::JarvisState;
use crate::terminal_engine::TerminalManager;

/// Host limit: dynamic tool calls per turn (user correction #5).
pub const MAX_DYNAMIC_TOOL_CALLS_PER_TURN: usize = 12;
/// Host limit: side-effect plans per turn (spec §13, enforced by C6).
pub const MAX_SIDE_EFFECT_PLANS_PER_TURN: usize = 1;
/// Host limit: whole-turn deadline in seconds (spec §23, 90–120s).
#[allow(dead_code)] // consumed by C7 streaming turn supervision
pub const TURN_DEADLINE_SECS: u64 = 90;

/// Server request method for dynamic tool calls.
pub const TOOL_CALL_METHOD: &str = "item/tool/call";

/// Dynamic tool names for `conversational.plan` (C6).
const PLAN_NAMESPACE: &str = "conversational";
const PLAN_TOOL: &str = "plan";

/// JSON-RPC error codes for the plan guard (stable host-side contract).
/// -32000 tool execution error · -32001 thread binding · -32002 call budget
/// · -32003 second side-effect plan in the same turn · -32004 plan rejected.
const PLAN_ALREADY_EXECUTED_CODE: i64 = -32003;
const PLAN_REJECTED_CODE: i64 = -32004;

/// Executes dynamic tool calls from the App Server (server requests).
#[derive(Clone)]
pub struct CodexToolService {
    app: AppHandle,
    runtime: CodexRuntimeManager,
    /// Per-thread budget of tool calls consumed during the current turn.
    /// Reset on `turn/started` notifications.
    call_budget: Arc<Mutex<HashMap<String, usize>>>,
    /// C6 TurnSafetyState (spec §13): has the single side-effecting
    /// `conversational.plan` of the current turn already been executed?
    /// Keyed by thread id, reset on `turn/started`.
    plan_executed: Arc<Mutex<HashMap<String, bool>>>,
    /// C9: cancellation token of the `conversational.plan` currently running
    /// for a thread (if any). `turn/interrupt` cancels it so the plan steps
    /// stop at the next checkpoint instead of mutating after the user asked
    /// to stop. Removed when the turn ends (any outcome).
    plan_cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl CodexToolService {
    pub fn new(runtime: CodexRuntimeManager, app: AppHandle) -> Self {
        Self {
            app,
            runtime,
            call_budget: Arc::new(Mutex::new(HashMap::new())),
            plan_executed: Arc::new(Mutex::new(HashMap::new())),
            plan_cancellations: Arc::new(Mutex::new(HashMap::new())),
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
            // C6 (spec §11-§13): the ONLY side-effecting tool. Mutations are
            // executed by the Rust backend through the visible PTYs, and the
            // receipt comes back in the same turn. At most one plan per turn.
            namespace_spec(
                PLAN_NAMESPACE,
                "Conversational control. The ONLY namespace that can cause real side effects, executed by Traflix Space through the visible PTYs. At most one plan per turn.",
                vec![tool_spec(
                    PLAN_TOOL,
                    "Return one typed conversational plan for the current user request. Operations: respond, clarify, agent_report, agent_send, agent_open, agent_handoff, agent_abort, terminal_close, terminal_restart, draft_prompt. Never include shell commands or guessed terminal IDs. The backend validates and executes it, then returns the execution receipt in this same turn.",
                    conversational_plan_schema(),
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

        // C6: the only side-effecting tool. Everything else stays on the
        // read-only dispatcher.
        if namespace == PLAN_NAMESPACE && tool_name == PLAN_TOOL {
            self.handle_conversational_plan(id, thread_id, &workspace_id, &tool_call_id, &input)
                .await;
            return true;
        }

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

    /// Resets the per-thread turn state when a new turn starts: the tool-call
    /// budget (C5) and the single-plan guard (C6 TurnSafetyState, spec §13).
    pub async fn reset_turn_state(&self, thread_id: &str) {
        self.call_budget.lock().await.remove(thread_id);
        self.plan_executed.lock().await.remove(thread_id);
    }

    /// C9: remembers the cancellation token of the plan running for a thread.
    pub async fn register_plan_cancel(&self, thread_id: &str, token: CancellationToken) {
        self.plan_cancellations.lock().await.insert(thread_id.to_string(), token);
    }

    /// C9: cancels the running plan of a thread (called by `turn/interrupt`
    /// BEFORE the interrupt is sent, so steps stop at the next checkpoint).
    pub async fn cancel_plan(&self, thread_id: &str) {
        let token = self.plan_cancellations.lock().await.remove(thread_id);
        if let Some(token) = token {
            token.cancel();
        }
    }

    /// C9: drops the plan cancellation entry when the turn ends (any outcome).
    pub async fn clear_plan_cancel(&self, thread_id: &str) {
        self.plan_cancellations.lock().await.remove(thread_id);
    }

    /// C6: executes `conversational.plan` through the existing Rust
    /// [`execute_plan`] and answers the server request with the execution
    /// receipt in the same turn (spec §12: the model keeps talking after the
    /// mutation). Host guarantees, enforced here in the backend (spec §13):
    ///
    /// - at most [`MAX_SIDE_EFFECT_PLANS_PER_TURN`] plan per turn, enforced
    ///   BEFORE any execution (a second plan → tool error
    ///   `side_effect_plan_already_executed`, the model can reply or ask);
    /// - the plan is deserialized and validated with the same typed
    ///   `ConversationalPlan` used by the legacy path;
    /// - the workspace is the thread's bound workspace (never cross-
    ///   workspace); every mutation inside `execute_plan` re-validates the
    ///   live workspace and the exact PTY generation before writing.
    async fn handle_conversational_plan(
        &self,
        id: u64,
        thread_id: &str,
        workspace_id: &str,
        request_id: &str,
        args: &Value,
    ) {
        // TurnSafetyState first: a second plan in the same turn never runs.
        // The slot is consumed by ANY plan attempt (even one later rejected
        // by decode/validate): a failed plan cannot be retried in the same
        // turn — the model must answer or ask the user (new turn).
        {
            let mut executed = self.plan_executed.lock().await;
            if !consume_plan_slot(&mut executed, thread_id) {
                drop(executed);
                warn!(thread_id, "codex second conversational.plan in the same turn rejected");
                self.respond_error(
                    id,
                    PLAN_ALREADY_EXECUTED_CODE,
                    "side_effect_plan_already_executed",
                )
                .await;
                return;
            }
        }

        // Typed decode: the arguments must be the ConversationalPlan shape
        // (snake_case operations, camelCase step fields — same as the legacy
        // conversational_plan tool). Malformed JSON → invalid params.
        let plan = match serde_json::from_value::<ConversationalPlan>(args.clone()) {
            Ok(plan) => plan,
            Err(err) => {
                self.respond_error(
                    id,
                    -32602,
                    &format!("invalid conversational.plan arguments: {err}"),
                )
                .await;
                return;
            }
        };
        // Typed validation: 1..=8 operations, bounded texts, supported
        // providers, allowlisted operations (control.rs).
        if let Err(error) = plan.validate() {
            self.respond_error(id, PLAN_REJECTED_CODE, &format!("conversational_plan_rejected: {error}"))
                .await;
            return;
        }

        let observed_at = now();
        let workspace = match load_workspace(&self.app, workspace_id, request_id, &observed_at).await
        {
            Ok(workspace) => workspace,
            Err(err) => {
                self.respond_error(id, PLAN_REJECTED_CODE, &format!("workspace unavailable: {}", err.message))
                    .await;
                return;
            }
        };
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
        let context = match JarvisToolService::new(&self.app.state::<JarvisState>().broker)
            .build_context(&workspace, invocation.clone(), terminals, RequestedDepth::LastResult)
            .map_err(|err| err.message)
            .and_then(|package| {
                package
                    .to_model_context_view(&[])
                    .map_err(|err| format!("context projection failed: {err:?}"))
            }) {
            Ok(context) => context,
            Err(message) => {
                self.respond_error(id, PLAN_REJECTED_CODE, &format!("context unavailable: {message}"))
                    .await;
                return;
            }
        };

        // C6/C9: a fresh cancellation token, registered so that a later
        // `turn/interrupt` cancels the running plan at its next checkpoint
        // (execute_plan checks the token before every side-effecting step).
        let cancellation = CancellationToken::new();
        self.register_plan_cancel(thread_id, cancellation.clone()).await;
        let execution = execute_plan(
            &self.app,
            &workspace,
            &invocation,
            &cancellation,
            plan,
            &context,
        )
        .await;
        self.clear_plan_cancel(thread_id).await;
        // The ExecutionReceipt goes back to the model in this same turn:
        // "Fatto, ho inviato a ..." on success, or the step failure text.
        // The model must not claim success without this receipt (spec §10).
        let receipt = json!({
            "response": execution.response,
            "warnings": execution.warnings,
        });
        debug!(
            thread_id,
            workspace_id,
            limit = MAX_SIDE_EFFECT_PLANS_PER_TURN,
            "codex conversational.plan executed"
        );
        let payload = json!({
            "content": [{
                "type": "inputText",
                "text": serde_json::to_string(&receipt).unwrap_or_else(|_| "{}".into()),
            }]
        });
        match self.runtime.client().await {
            Ok(client) => {
                if let Err(err) = client.respond(id, payload).await {
                    warn!(error = %err, "codex conversational.plan response failed");
                }
            }
            Err(err) => warn!(error = %err, "codex runtime gone before plan response"),
        }
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

/// Pure TurnSafetyState slot consumption (spec §13): returns `true` when
/// the single plan slot of the turn was consumed now, `false` when a plan
/// was already executed in this turn (the caller must refuse the second one).
fn consume_plan_slot(executed: &mut HashMap<String, bool>, thread_id: &str) -> bool {
    if executed.get(thread_id).copied().unwrap_or(false) {
        return false;
    }
    executed.insert(thread_id.to_owned(), true);
    true
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
            vec!["workspace", "terminals", "agent", "markdown", "ui", "conversational"]
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
    fn plan_tool_is_the_only_mutating_namespace_and_uses_the_typed_schema() {
        let specs = CodexToolService::dynamic_tool_specs();
        let conversational = specs
            .iter()
            .find(|spec| spec["name"] == "conversational")
            .expect("conversational namespace present");
        let plan = conversational["tools"]
            .as_array()
            .expect("conversational tools")
            .iter()
            .find(|tool| tool["name"] == "plan")
            .expect("conversational.plan present");
        // The input schema is the shared typed ConversationalPlan schema.
        let schema = plan["inputSchema"].clone();
        assert_eq!(schema["required"][0], "operations");
        let enum_ops: Vec<&str> = schema["properties"]["operations"]["items"]["properties"]
            ["operation"]["enum"]
            .as_array()
            .expect("operation enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            enum_ops,
            vec![
                "respond",
                "clarify",
                "agent_report",
                "agent_send",
                "agent_open",
                "agent_handoff",
                "agent_abort",
                "terminal_close",
                "terminal_restart",
                "draft_prompt",
            ]
        );
        assert!(schema["properties"]["operations"]["items"]["properties"]["allowBusy"].is_object());
        // Only `conversational.plan` is side-effecting; the read-only
        // namespace set is unchanged.
        let read_only = vec!["workspace", "terminals", "agent", "markdown", "ui"];
        for spec in specs
            .iter()
            .filter(|spec| spec["name"] != "conversational")
        {
            let name = spec["name"].as_str().unwrap_or_default();
            assert!(
                read_only.contains(&name),
                "unexpected extra namespace {name}"
            );
        }
    }

    #[test]
    fn plan_guard_allows_one_plan_per_turn_then_rejects() {
        // Pure TurnSafetyState semantics: first plan consumes the slot,
        // second plan in the same turn is refused, reset re-arms it.
        let mut state = std::collections::HashMap::new();
        assert!(consume_plan_slot(&mut state, "thread-a"));
        assert!(!consume_plan_slot(&mut state, "thread-a"));
        // Different thread has its own slot (workspace isolation).
        assert!(consume_plan_slot(&mut state, "thread-b"));
        state.remove("thread-a");
        assert!(consume_plan_slot(&mut state, "thread-a"));
    }

    #[test]
    fn plan_arguments_decode_and_validate_like_the_legacy_tool() {
        // A valid plan decodes and passes the typed validation.
        let valid = json!({
            "operations": [{
                "operation": "agent_send",
                "provider": "codex",
                "target": "Codex Auth",
                "prompt": "controlla i test",
            }],
            "response": "Controllo.",
        });
        let plan = serde_json::from_value::<ConversationalPlan>(valid)
            .expect("plan decodes with camelCase step fields");
        assert!(plan.validate().is_ok());

        // An unknown operation fails at typed decode (strict enum), even
        // before the typed validation runs.
        let unknown = json!({ "operations": [{ "operation": "shell_exec" }] });
        assert!(serde_json::from_value::<ConversationalPlan>(unknown).is_err());

        // An empty plan decodes but is rejected by the typed validation
        // (1..=8 operations, bounded texts, supported providers).
        let empty = json!({ "operations": [] });
        let plan = serde_json::from_value::<ConversationalPlan>(empty).expect("empty array decodes");
        assert!(plan.validate().is_err());

        // Malformed arguments (operations not an array) fail to decode.
        assert!(serde_json::from_value::<ConversationalPlan>(json!({"operations": 3})).is_err());
        assert!(serde_json::from_value::<ConversationalPlan>(json!({})).is_err());
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
