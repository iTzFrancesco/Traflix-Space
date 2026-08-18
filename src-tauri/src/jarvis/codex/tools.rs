//! C5/C6 — Dynamic tools (read-only + conversational control).
//!
//! Traflix Jarvis never receives direct repository access. Project knowledge
//! comes from the bounded Context Broker, runtime facts come from read-only
//! workspace/terminal/agent tools, and every mutation goes through the single
//! typed `conversational.plan` tool.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

#[path = "read_handlers.rs"]
mod read_handlers;
#[path = "tool_definitions.rs"]
mod tool_definitions;

use super::rpc::JsonRpcClient;
use super::runtime::CodexRuntimeManager;
use super::threads::ThreadRegistry;
use crate::jarvis::chat::{load_workspace, now};
use crate::jarvis::commands::reconcile_live_registry;
use crate::jarvis::control::{execute_plan, ConversationalPlan};
use crate::jarvis::tools::{list_terminals_for_workspace, JarvisToolService};
use crate::jarvis::types::{InvocationBinding, RequestedDepth};
use crate::jarvis::JarvisState;
use crate::terminal_engine::TerminalManager;

pub const MAX_DYNAMIC_TOOL_CALLS_PER_TURN: usize = 12;
pub const MAX_SIDE_EFFECT_PLANS_PER_TURN: usize = 1;
pub const TOOL_CALL_METHOD: &str = "item/tool/call";

/// Dedicated wall-clock deadline for every read tool, including preparation.
/// The JSON-RPC response write is deliberately outside this timeout so a
/// cancellation can never interrupt a response line half-way through.
const READ_TOOL_TIMEOUT: Duration = Duration::from_secs(8);

const PLAN_NAMESPACE: &str = "conversational";
const PLAN_TOOL: &str = "plan";
const PLAN_ALREADY_EXECUTED_CODE: i64 = -32003;
const PLAN_REJECTED_CODE: i64 = -32004;

#[derive(Clone)]
pub struct CodexToolService {
    app: AppHandle,
    runtime: CodexRuntimeManager,
    call_budget: Arc<Mutex<HashMap<String, usize>>>,
    plan_executed: Arc<Mutex<HashMap<String, bool>>>,
    plan_cancellations: Arc<Mutex<HashMap<(String, String), CancellationToken>>>,
    server_client: Option<Arc<JsonRpcClient>>,
}

impl CodexToolService {
    pub fn new(runtime: CodexRuntimeManager, app: AppHandle) -> Self {
        Self {
            app,
            runtime,
            call_budget: Arc::new(Mutex::new(HashMap::new())),
            plan_executed: Arc::new(Mutex::new(HashMap::new())),
            plan_cancellations: Arc::new(Mutex::new(HashMap::new())),
            server_client: None,
        }
    }

    /// Binds a bridge clone to the exact App Server client that delivered a
    /// server request. A runtime restart must never route the old request's
    /// JSON-RPC response into the new process.
    pub fn for_server_client(&self, client: Arc<JsonRpcClient>) -> Self {
        let mut scoped = self.clone();
        scoped.server_client = Some(client);
        scoped
    }

    async fn client(&self) -> Result<Arc<JsonRpcClient>, super::runtime::RuntimeError> {
        match &self.server_client {
            Some(client) => Ok(client.clone()),
            None => self.runtime.client().await,
        }
    }

    pub fn dynamic_tool_specs() -> Vec<Value> {
        tool_definitions::dynamic_tool_specs()
    }
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
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tool_call_id = params
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let namespace = params
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tool_name = params
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let name = format!("{namespace}.{tool_name}");
        let input = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let workspace_id = match self.app.try_state::<ThreadRegistry>() {
            Some(registry) => registry.workspace_for_thread(thread_id).await,
            None => None,
        };
        let Some(workspace_id) = workspace_id else {
            self.respond_error(id, -32001, "thread has no workspace binding")
                .await;
            return true;
        };

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
        let started = Instant::now();
        info!(
            thread_id,
            call_id = tool_call_id,
            workspace_id,
            tool = name,
            rpc_id = id,
            "[JARVIS-CODEX-TOOL] start",
        );

        if namespace == PLAN_NAMESPACE && tool_name == PLAN_TOOL {
            if turn_id.is_empty() {
                self.respond_error(id, -32602, "missing turnId for conversational.plan")
                    .await;
                return true;
            }
            self.handle_conversational_plan(
                id,
                thread_id,
                &turn_id,
                &workspace_id,
                &tool_call_id,
                &input,
                started,
            )
            .await;
            return true;
        }

        let legacy_name = legacy_dispatcher_name(namespace, tool_name);
        let result = self
            .execute_read_tool(&workspace_id, &tool_call_id, &legacy_name, &input)
            .await;

        // Response I/O is intentionally outside the read-tool timeout. The
        // JsonRpcClient serializes complete JSONL writes through its stdin
        // mutex, so a slow writer can wait safely without being cancelled
        // half-way through a response line.
        match result {
            Ok(value) => {
                let payload = json!({
                    "content": [{
                        "type": "inputText",
                        "text": serde_json::to_string(&value).unwrap_or_else(|_| "{}".into()),
                    }]
                });
                match self.client().await {
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

    pub async fn reset_turn_state(&self, thread_id: &str) {
        self.call_budget.lock().await.remove(thread_id);
        self.plan_executed.lock().await.remove(thread_id);
    }

    pub async fn register_plan_cancel(
        &self,
        thread_id: &str,
        turn_id: &str,
        token: CancellationToken,
    ) {
        self.plan_cancellations
            .lock()
            .await
            .insert((thread_id.to_owned(), turn_id.to_owned()), token);
    }

    pub async fn cancel_plan(&self, thread_id: &str, turn_id: &str) {
        let token = self
            .plan_cancellations
            .lock()
            .await
            .remove(&(thread_id.to_owned(), turn_id.to_owned()));
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub async fn clear_plan_cancel(&self, thread_id: &str, turn_id: &str) {
        self.plan_cancellations
            .lock()
            .await
            .remove(&(thread_id.to_owned(), turn_id.to_owned()));
    }

    async fn handle_conversational_plan(
        &self,
        id: u64,
        thread_id: &str,
        turn_id: &str,
        workspace_id: &str,
        request_id: &str,
        args: &Value,
        started: Instant,
    ) {
        {
            let mut executed = self.plan_executed.lock().await;
            if !consume_plan_slot(&mut executed, thread_id) {
                drop(executed);
                warn!(
                    thread_id,
                    "codex second conversational.plan in the same turn rejected"
                );
                self.respond_error(
                    id,
                    PLAN_ALREADY_EXECUTED_CODE,
                    "side_effect_plan_already_executed",
                )
                .await;
                return;
            }
        }

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
        if let Err(error) = plan.validate() {
            self.respond_error(
                id,
                PLAN_REJECTED_CODE,
                &format!("conversational_plan_rejected: {error}"),
            )
            .await;
            return;
        }

        let observed_at = now();
        let workspace =
            match load_workspace(&self.app, workspace_id, request_id, &observed_at).await {
                Ok(workspace) => workspace,
                Err(err) => {
                    self.respond_error(
                        id,
                        PLAN_REJECTED_CODE,
                        &format!("workspace unavailable: {}", err.message),
                    )
                    .await;
                    return;
                }
            };
        reconcile_live_registry(&self.app, &observed_at).await;
        let manager = self.app.state::<TerminalManager>();
        let terminals = list_terminals_for_workspace(&manager, &workspace, &observed_at).await;
        let invocation =
            InvocationBinding::new(request_id, workspace_id, None, None, observed_at.clone());
        let context = match JarvisToolService::new(&self.app.state::<JarvisState>().broker)
            .build_context(
                &workspace,
                invocation.clone(),
                terminals,
                RequestedDepth::LastResult,
            )
            .map_err(|err| err.message)
            .and_then(|package| {
                package
                    .to_model_context_view(&[])
                    .map_err(|err| format!("context projection failed: {err:?}"))
            }) {
            Ok(context) => context,
            Err(message) => {
                self.respond_error(
                    id,
                    PLAN_REJECTED_CODE,
                    &format!("context unavailable: {message}"),
                )
                .await;
                return;
            }
        };

        let cancellation = CancellationToken::new();
        self.register_plan_cancel(thread_id, turn_id, cancellation.clone())
            .await;
        let execution = execute_plan(
            &self.app,
            &workspace,
            &invocation,
            &cancellation,
            plan,
            &context,
        )
        .await;
        self.clear_plan_cancel(thread_id, turn_id).await;
        let receipt = json!({
            "response": execution.response,
            "warnings": execution.warnings,
            "steps": execution.steps,
        });
        info!(
            thread_id,
            workspace_id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "[JARVIS-CODEX-PLAN] completed",
        );
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
        match self.client().await {
            Ok(client) => {
                if let Err(err) = client.respond(id, payload).await {
                    warn!(error = %err, "codex conversational.plan response failed");
                }
            }
            Err(err) => warn!(error = %err, "codex runtime gone before plan response"),
        }
    }

    /// Fast-path read tool execution (C10 latency): the 8s deadline now wraps
    /// the entire tool preparation + execution path. Each tool prepares only
    /// the runtime slice it needs; agent registry reads do not enumerate all
    /// terminals and markdown.read does not build a duplicate terminal view.
    async fn execute_read_tool(
        &self,
        workspace_id: &str,
        request_id: &str,
        legacy_name: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            READ_TOOL_TIMEOUT,
            self.execute_read_tool_inner(workspace_id, request_id, legacy_name, input, started),
        )
        .await;

        match outcome {
            Ok(result) => result,
            Err(_) => {
                warn!(
                    tool = legacy_name,
                    total_ms = started.elapsed().as_millis() as u64,
                    "[JARVIS-CODEX-TOOL] failed: full read tool timed out",
                );
                Err(format!(
                    "{legacy_name} timed out after {}s",
                    READ_TOOL_TIMEOUT.as_secs()
                ))
            }
        }
    }

    async fn execute_read_tool_inner(
        &self,
        workspace_id: &str,
        request_id: &str,
        legacy_name: &str,
        input: &Value,
        started: Instant,
    ) -> Result<Value, String> {
        let observed_at = now();
        let workspace = load_workspace(&self.app, workspace_id, request_id, &observed_at)
            .await
            .map_err(|err| err.message)?;

        // Registry reconciliation is needed only by tools that expose agent
        // registry state (and workspace.overview, whose context includes the
        // agent summary). Terminal-only reads can go straight to the manager.
        if matches!(
            legacy_name,
            "agent_list"
                | "agent_status"
                | "agent_last_result"
                | "agent_activity"
                | "workspace_overview"
        ) {
            reconcile_live_registry(&self.app, &observed_at).await;
        }

        // Agent reads join the live terminal view so the model receives the
        // same effective navbar title as the user, correlated by immutable
        // terminal id + generation. Titles remain semantic hints only.
        let terminals = if matches!(
            legacy_name,
            "terminal_list"
                | "agent_list"
                | "agent_status"
                | "agent_last_result"
                | "agent_activity"
                | "agent_tail"
                | "workspace_overview"
                | "ui_open_terminal"
        ) {
            let manager = self.app.state::<TerminalManager>();
            list_terminals_for_workspace(&manager, &workspace, &observed_at).await
        } else {
            Vec::new()
        };

        let invocation =
            InvocationBinding::new(request_id, workspace_id, None, None, observed_at.clone());
        let prepare_ms = started.elapsed().as_millis() as u64;
        info!(
            tool = legacy_name,
            prepare_ms, "[JARVIS-CODEX-TOOL] context-ready",
        );

        let execution_started = Instant::now();
        let result = self
            .dispatch_read_tool(
                &workspace,
                &invocation,
                &terminals,
                &observed_at,
                legacy_name,
                input,
            )
            .await;

        match &result {
            Ok(value) => {
                let response_bytes = serde_json::to_string(value)
                    .map(|json| json.len())
                    .unwrap_or(0);
                info!(
                    tool = legacy_name,
                    execute_ms = execution_started.elapsed().as_millis() as u64,
                    total_ms = started.elapsed().as_millis() as u64,
                    response_bytes,
                    "[JARVIS-CODEX-TOOL] completed",
                );
            }
            Err(message) => {
                warn!(
                    tool = legacy_name,
                    total_ms = started.elapsed().as_millis() as u64,
                    error = message,
                    "[JARVIS-CODEX-TOOL] failed",
                );
            }
        }

        result
    }

    async fn respond_error(&self, id: u64, code: i64, message: &str) {
        match self.client().await {
            Ok(client) => {
                if let Err(err) = client.respond_error(id, code, message).await {
                    warn!(error = %err, "codex tool error response failed");
                }
            }
            Err(err) => warn!(error = %err, "codex runtime gone before tool error response"),
        }
    }
}

fn consume_plan_slot(executed: &mut HashMap<String, bool>, thread_id: &str) -> bool {
    if executed.get(thread_id).copied().unwrap_or(false) {
        return false;
    }
    executed.insert(thread_id.to_owned(), true);
    true
}

/// Same read-checkpoint phases as the legacy dispatcher in `chat.rs`, so the
/// activity widget keeps showing the same labels while a Codex tool runs.
fn legacy_dispatcher_name(namespace: &str, tool: &str) -> String {
    let legacy_namespace = if namespace == "terminals" {
        "terminal"
    } else {
        namespace
    };
    format!("{legacy_namespace}_{tool}")
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
            vec![
                "workspace",
                "terminals",
                "agent",
                "markdown",
                "ui",
                "conversational"
            ]
        );
        for spec in &specs {
            for tool in spec["tools"].as_array().unwrap_or(&Vec::new()) {
                let tool_name = tool["name"].as_str().unwrap_or_default();
                assert!(
                    !tool_name.contains('.'),
                    "tool name must be plain: {tool_name}"
                );
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
        assert!(schema["properties"]["operations"]["items"]["properties"]["followUp"].is_object());
        let read_only = ["workspace", "terminals", "agent", "markdown", "ui"];
        for spec in specs.iter().filter(|spec| spec["name"] != "conversational") {
            let name = spec["name"].as_str().unwrap_or_default();
            assert!(
                read_only.contains(&name),
                "unexpected extra namespace {name}"
            );
        }
    }

    #[test]
    fn plan_guard_allows_one_plan_per_turn_then_rejects() {
        let mut state = std::collections::HashMap::new();
        assert!(consume_plan_slot(&mut state, "thread-a"));
        assert!(!consume_plan_slot(&mut state, "thread-a"));
        assert!(consume_plan_slot(&mut state, "thread-b"));
        state.remove("thread-a");
        assert!(consume_plan_slot(&mut state, "thread-a"));
    }

    #[test]
    fn plan_arguments_decode_and_validate_like_the_legacy_tool() {
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

        let unknown = json!({ "operations": [{ "operation": "shell_exec" }] });
        assert!(serde_json::from_value::<ConversationalPlan>(unknown).is_err());

        let empty = json!({ "operations": [] });
        let plan =
            serde_json::from_value::<ConversationalPlan>(empty).expect("empty array decodes");
        assert!(plan.validate().is_err());

        assert!(serde_json::from_value::<ConversationalPlan>(json!({"operations": 3})).is_err());
        assert!(serde_json::from_value::<ConversationalPlan>(json!({})).is_err());
    }

    #[test]
    fn namespaced_name_maps_to_legacy_dispatcher() {
        assert_eq!(legacy_dispatcher_name("agent", "list"), "agent_list");
        assert_eq!(
            legacy_dispatcher_name("ui", "open_terminal"),
            "ui_open_terminal"
        );
        assert_eq!(legacy_dispatcher_name("terminals", "list"), "terminal_list");
        assert_eq!(
            legacy_dispatcher_name("workspace", "overview"),
            "workspace_overview"
        );
    }

    #[test]
    fn read_tool_terminal_requirements_are_scoped() {
        fn needs_terminals(name: &str) -> bool {
            matches!(
                name,
                "terminal_list" | "agent_tail" | "workspace_overview" | "ui_open_terminal"
            )
        }
        assert!(needs_terminals("terminal_list"));
        assert!(needs_terminals("agent_tail"));
        assert!(needs_terminals("workspace_overview"));
        assert!(!needs_terminals("agent_list"));
        assert!(!needs_terminals("agent_status"));
        assert!(!needs_terminals("agent_last_result"));
        assert!(!needs_terminals("agent_activity"));
        assert!(!needs_terminals("markdown_read"));
    }
}
