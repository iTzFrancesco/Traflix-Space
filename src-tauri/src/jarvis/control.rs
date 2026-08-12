//! Conversational control is the seam between the model's semantic plan and
//! Traflix's real, visible PTYs. The model can propose only the typed values
//! in this module; this module owns target resolution, workspace validation,
//! bounded context, readiness and side effects.

use crate::agent::registry::AgentDefinition;
use crate::jarvis::actions::{prompt_bytes, validate_agent_text};
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::tools::{
    attach_terminal_titles, list_terminals_for_workspace, JarvisToolService,
};

/// Provider alias resolution for plan execution. The pi agent is commonly
/// named by its single letter ('p', 'agente P') in speech transcripts, which
/// STT may deliver without the trailing 'i'; map it to the canonical 'pi'
/// provider instead of rejecting or misreading it as another agent.
fn normalize_plan_provider(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "p" | "pi" | "agente p" | "agente pi" | "agent p" | "agent pi" => Some("pi".to_string()),
        other => normalize_provider(other),
    }
}
use crate::jarvis::types::{
    AgentAssignmentBinding, AgentSessionContext, AgentState, AgentTail, InvocationBinding,
    Provenance, TerminalSummary,
};
use crate::terminal_engine::{
    TerminalAgentSnapshot, TerminalInputOrigin, TerminalManager, TerminalRuntimeIdentity,
};
use crate::workspace::registry::{TerminalConfig, WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

pub const MAX_PLAN_OPERATIONS: usize = 8;
pub const MAX_PLAN_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_HANDOFF_CONTEXT_BYTES: usize = 6 * 1024;
pub const DEFAULT_TAIL_LINES: usize = 40;
pub const MAX_TAIL_LINES: usize = 100;
pub const MAX_TAIL_BYTES: usize = 12 * 1024;
const MAX_PENDING_CONVERSATIONS: usize = 32;
const PENDING_CONVERSATION_TTL: Duration = Duration::from_secs(10 * 60);
const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_POLL: Duration = Duration::from_millis(120);
static NEXT_AGENT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_ASSIGNMENT_ID: AtomicU64 = AtomicU64::new(1);

const DISPATCH_PTY_WRITE_ACCEPTED: &str = "pty_write_accepted";
const DISPATCH_PROMPT_SUBMITTED: &str = "prompt_submitted";
/// Reserved terminal state for a future provider/session-start observation.
/// Current PTY-only dispatches must remain `submission_unconfirmed`.
#[allow(dead_code)]
const DISPATCH_TURN_STARTED: &str = "turn_started";
const DISPATCH_SUBMISSION_UNCONFIRMED: &str = "submission_unconfirmed";
const DISPATCH_TURN_FAILED: &str = "turn_failed";

fn new_assignment_id() -> String {
    format!(
        "assignment:{}:{}",
        Utc::now().timestamp_millis(),
        NEXT_ASSIGNMENT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

/// JSON input schema of the typed conversational plan tool. Single source of
/// truth shared by the legacy `conversational_plan` definition (chat.rs) and
/// the C6 dynamic tool `conversational.plan` (codex/tools.rs), so both model
/// paths always see the same typed operations.
pub(crate) fn conversational_plan_schema() -> serde_json::Value {
    serde_json::json!({
        "type":"object",
        "properties": {
            "operations": {
                "type":"array",
                "minItems":1,
                "maxItems":8,
                "items": {
                    "type":"object",
                    "properties": {
                        "operation": {"type":"string","enum":["respond","clarify","agent_report","agent_send","agent_open","agent_handoff","agent_abort","terminal_close","terminal_restart","draft_prompt"]},
                        "provider": {"type":"string","enum":["codex","opencode","pi","freebuff","claude"]},
                        "target": {"type":"string","maxLength":4096},
                        "source": {"type":"string","maxLength":4096},
                        "destination": {"type":"string","maxLength":4096},
                        "prompt": {"type":"string","maxLength":16384},
                        "confirmed": {"type":"boolean"},
                        "allowBusy": {"type":"boolean"}
                    },
                    "required":["operation"],
                    "additionalProperties":false
                }
            },
            "response": {"type":"string","maxLength":4096}
        },
        "required":["operations"],
        "additionalProperties":false
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanOperation {
    Respond,
    Clarify,
    AgentReport,
    AgentSend,
    AgentOpen,
    AgentHandoff,
    AgentAbort,
    TerminalClose,
    TerminalRestart,
    DraftPrompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStep {
    pub operation: PlanOperation,
    #[serde(default)]
    pub provider: Option<String>,
    /// A semantic query, never a shell command. It can mention a provider,
    /// read-only terminal title, task or result topic.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
    /// Explicit conversational choice to append work to a known busy session.
    /// This is never sufficient by itself: the pending clarification and the
    /// current terminal generation must also match.
    #[serde(default)]
    pub allow_busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationalPlan {
    pub operations: Vec<ConversationStep>,
    #[serde(default)]
    pub response: Option<String>,
}

impl ConversationalPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.operations.is_empty() || self.operations.len() > MAX_PLAN_OPERATIONS {
            return Err("il piano deve contenere da una a otto operazioni".to_string());
        }
        if let Some(response) = &self.response {
            validate_plan_text(response)?;
        }
        for step in &self.operations {
            if let Some(provider) = &step.provider {
                normalize_plan_provider(provider)
                    .ok_or_else(|| format!("provider non supportato: {provider}"))?;
            }
            for value in [&step.target, &step.source, &step.destination, &step.prompt] {
                if let Some(value) = value {
                    validate_plan_text(value)?;
                }
            }
            match step.operation {
                // A continuation turn may intentionally omit a prompt because
                // the backend restores it from the exact pending intent. A
                // fresh send/handoff with no prompt still fails at execution.
                PlanOperation::AgentSend | PlanOperation::AgentHandoff => {
                    if let Some(prompt) = &step.prompt {
                        validate_agent_text(prompt)
                            .map_err(|_| "prompt agente non valido".to_string())?;
                    }
                }
                PlanOperation::AgentOpen => {
                    if let Some(prompt) = &step.prompt {
                        validate_agent_text(prompt)
                            .map_err(|_| "prompt iniziale non valido".to_string())?;
                    }
                }
                PlanOperation::DraftPrompt => {
                    validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                        .map_err(|_| "draft non valido".to_string())?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn validate_plan_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_PLAN_TEXT_BYTES || value.contains('\0') {
        return Err("testo del piano oltre il limite".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingConversationKind {
    Clarification,
    Confirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingConversationalIntent {
    pub workspace_id: String,
    pub kind: PendingConversationKind,
    pub question: String,
    pub operation: PlanOperation,
    pub terminal_id: Option<String>,
    pub generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<AgentAssignmentBinding>,
    pub created_at: String,
    pub expires_at: String,
    pub plan: ConversationalPlan,
}

#[derive(Default)]
pub struct ConversationalControlState {
    pending: Mutex<HashMap<String, PendingConversationalIntent>>,
    last_assignments: Mutex<HashMap<String, AgentAssignmentBinding>>,
}

impl ConversationalControlState {
    pub fn pending(&self, workspace_id: &str) -> Option<PendingConversationalIntent> {
        let mut pending = self.pending.lock().ok()?;
        let value = pending.get(workspace_id).cloned()?;
        if value.expires_at < now() {
            pending.remove(workspace_id);
            return None;
        }
        Some(value)
    }

    pub fn put(&self, intent: PendingConversationalIntent) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(intent.workspace_id.clone(), intent);
            while pending.len() > MAX_PENDING_CONVERSATIONS {
                if let Some(key) = pending
                    .values()
                    .min_by(|left, right| left.created_at.cmp(&right.created_at))
                    .map(|item| item.workspace_id.clone())
                {
                    pending.remove(&key);
                } else {
                    break;
                }
            }
        }
    }

    pub fn clear(&self, workspace_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(workspace_id);
        }
    }

    pub fn replace_plan(&self, workspace_id: &str, operations: Vec<ConversationStep>) {
        if operations.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(intent) = pending.get_mut(workspace_id) {
                intent.plan.operations = operations;
            }
        }
    }

    pub fn record_assignment(&self, workspace_id: &str, binding: AgentAssignmentBinding) {
        if let Ok(mut assignments) = self.last_assignments.lock() {
            assignments.insert(workspace_id.to_string(), binding);
        }
    }

    pub fn last_assignment(&self, workspace_id: &str) -> Option<AgentAssignmentBinding> {
        self.last_assignments
            .lock()
            .ok()
            .and_then(|assignments| assignments.get(workspace_id).cloned())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenedEvent {
    pub workspace_id: String,
    pub terminal: TerminalConfig,
    pub generation: u64,
    pub process_id: Option<u32>,
    pub launch_state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClosedEvent {
    pub workspace_id: String,
    pub terminal_id: String,
    pub generation: u64,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TargetResolution {
    Selected(ResolvedAgentTarget),
    Ambiguous(Vec<String>),
    NotFound,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAgentTarget {
    pub terminal: TerminalSummary,
    pub session: AgentSessionContext,
}

#[derive(Debug, Clone)]
pub struct ControlExecution {
    pub response: String,
    pub warnings: Vec<String>,
    pub steps: Vec<StepExecutionReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepExecutionReceipt {
    pub operation: PlanOperation,
    pub status: &'static str,
    pub target: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<AgentRecipientReceipt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecipientReceipt {
    pub assignment_id: String,
    pub agent_alias: String,
    pub agent_session_id: String,
    pub terminal_id: String,
    pub generation: u64,
    pub process_id: Option<u32>,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub display_title: String,
}

#[derive(Debug, Clone)]
struct StepExecutionOutcome {
    response: String,
    status: &'static str,
    target: Option<String>,
    recipient: Option<AgentRecipientReceipt>,
    stages: Vec<&'static str>,
}

#[derive(Debug, Clone)]
struct AgentDispatchReceipt {
    status: &'static str,
    stages: Vec<&'static str>,
    binding: AgentAssignmentBinding,
    recipient: AgentRecipientReceipt,
}

fn plain_outcome(response: String) -> StepExecutionOutcome {
    StepExecutionOutcome {
        response,
        status: "succeeded",
        target: None,
        recipient: None,
        stages: Vec::new(),
    }
}

fn unconfirmed_dispatch_stages() -> Vec<&'static str> {
    vec![
        DISPATCH_PTY_WRITE_ACCEPTED,
        DISPATCH_PROMPT_SUBMITTED,
        DISPATCH_SUBMISSION_UNCONFIRMED,
    ]
}

/// Request-scoped safety net: every running control checkpoint is closed even
/// when an early `?` return happens during PTY setup or readiness polling.
struct CheckpointGuard {
    app: AppHandle,
    request_id: String,
    workspace_id: String,
    phase: String,
    armed: bool,
}

impl CheckpointGuard {
    fn new(app: &AppHandle, invocation: &InvocationBinding, phase: &str) -> Self {
        Self {
            app: app.clone(),
            request_id: invocation.request_id.clone(),
            workspace_id: invocation.target_workspace_id.clone(),
            phase: phase.to_string(),
            armed: true,
        }
    }

    fn complete(&mut self) {
        self.armed = false;
    }
}

impl Drop for CheckpointGuard {
    fn drop(&mut self) {
        if self.armed {
            emit_checkpoint(
                &self.app,
                &self.request_id,
                &self.workspace_id,
                &self.phase,
                "Operazione non riuscita.",
                JarvisActivityStatus::Failed,
                None,
            );
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenResult {
    pub provider: String,
    pub terminal_id: String,
    pub generation: u64,
    pub initial_prompt_sent: bool,
    pub agent_alias: String,
    pub agent_session_id: String,
    pub assignment_id: Option<String>,
    pub dispatch_status: Option<&'static str>,
    pub dispatch_stages: Vec<&'static str>,
}

/// Typed command seam for callers that already have an explicit provider.
/// The conversational planner uses the same implementation after its own
/// semantic interpretation; no caller can inject a shell command here.
pub async fn open_agent_for_invocation(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    provider: &str,
    initial_prompt: Option<String>,
) -> Result<AgentOpenResult, String> {
    let opened = open_agent(app, workspace, invocation, provider, initial_prompt).await?;
    let OpenResult::Opened {
        provider,
        sent,
        terminal_id,
        generation,
        agent_alias,
        agent_session_id,
        dispatch,
    } = opened;
    Ok(AgentOpenResult {
        provider,
        terminal_id,
        generation,
        initial_prompt_sent: sent,
        agent_alias,
        agent_session_id,
        assignment_id: dispatch
            .as_ref()
            .map(|item| item.binding.assignment_id.clone()),
        dispatch_status: dispatch.as_ref().map(|item| item.status),
        dispatch_stages: dispatch.map(|item| item.stages).unwrap_or_default(),
    })
}

pub async fn execute_plan(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    cancellation: &CancellationToken,
    plan: ConversationalPlan,
    context: &crate::jarvis::types::ModelContextViewV1,
) -> ControlExecution {
    if let Err(error) = plan.validate() {
        return ControlExecution {
            response: format!("Non ho potuto validare il piano: {error}."),
            warnings: vec!["typed_plan_rejected".to_string()],
            steps: Vec::new(),
        };
    }

    let state = app.state::<crate::jarvis::JarvisState>();
    let pending = state.control.pending(&invocation.target_workspace_id);
    let (operations, resumes_pending) = operations_for_execution(&plan, pending.as_ref());
    if let Err(error) = validate_agent_dispatches(&operations) {
        return ControlExecution {
            response: error,
            warnings: vec!["agent_dispatch_rejected".to_string()],
            steps: Vec::new(),
        };
    }
    state.control.clear(&invocation.target_workspace_id);
    let mut response = plan.response.clone().unwrap_or_default();
    let mut warnings = Vec::new();
    let mut receipts = Vec::new();
    let mut reserved_terminal_ids = HashSet::new();

    if !cancellation.is_cancelled()
        && pending.is_none()
        && should_parallelize_agent_sends(&operations)
    {
        let parallel_context = refresh_operational_context(app, workspace, invocation, context)
            .await
            .unwrap_or_else(|_| context.clone());
        if let Some(prepared) =
            prepare_parallel_agent_sends(app, &parallel_context, &operations).await
        {
            let results = join_all(
                prepared
                    .into_iter()
                    .map(|(step, target, prompt)| async move {
                        let label = target_label(&target);
                        let result = send_to_target(app, invocation, &target, &prompt, None).await;
                        (step, label, result)
                    }),
            )
            .await;
            for (step, label, result) in results {
                match result {
                    Ok(dispatch) => {
                        state.control.record_assignment(
                            &invocation.target_workspace_id,
                            dispatch.binding.clone(),
                        );
                        let message = format!("Fatto, l'ho inviato a {label}.");
                        response = append_response(response, &message);
                        receipts.push(StepExecutionReceipt {
                            operation: step.operation,
                            status: dispatch.status,
                            target: Some(label),
                            message,
                            recipient: Some(dispatch.recipient),
                            stages: dispatch.stages,
                        });
                    }
                    Err(error) => {
                        warnings.push("independent_agent_step_failed".to_string());
                        let brief = brief_control_error(&error);
                        let stages = dispatch_failure_stages(&error);
                        response = append_response(response, &brief);
                        receipts.push(StepExecutionReceipt {
                            operation: step.operation,
                            status: dispatch_failure_status(&error),
                            target: Some(label),
                            message: error,
                            recipient: None,
                            stages,
                        });
                    }
                }
            }
            if response.trim().is_empty() {
                response = "Fatto.".to_string();
            }
            return ControlExecution {
                response: compact_response(&response),
                warnings,
                steps: receipts,
            };
        }
    }

    for (index, step) in operations.iter().enumerate() {
        if cancellation.is_cancelled() {
            return ControlExecution {
                response: "La richiesta è stata annullata.".to_string(),
                warnings,
                steps: receipts,
            };
        }
        info!(
            request_id = %invocation.request_id,
            workspace_id = %invocation.target_workspace_id,
            operation = ?step.operation,
            provider = step.provider.as_deref().unwrap_or(""),
            target = step.target.as_deref().unwrap_or(""),
            "Jarvis plan step executing"
        );
        let step_pending = if resumes_pending && index == 0 {
            pending.as_ref()
        } else {
            None
        };
        let step_context =
            match refresh_operational_context(app, workspace, invocation, context).await {
                Ok(context) => context,
                Err(error) => {
                    let message = format!("Non ho eseguito questo passaggio: {error}.");
                    let stages = dispatch_failure_stages(&message);
                    response = append_response(response, &message);
                    warnings.push("operational_context_refresh_failed".to_string());
                    receipts.push(StepExecutionReceipt {
                        operation: step.operation.clone(),
                        status: "failed",
                        target: step.target.clone().or_else(|| step.provider.clone()),
                        message,
                        recipient: None,
                        stages,
                    });
                    if matches!(
                        step.operation,
                        PlanOperation::AgentSend | PlanOperation::AgentOpen
                    ) {
                        continue;
                    }
                    break;
                }
            };
        let result = execute_step(
            app,
            workspace,
            invocation,
            &step_context,
            step_pending,
            &mut reserved_terminal_ids,
            step,
        )
        .await;
        match result {
            Ok(outcome) => {
                if !outcome.response.is_empty() {
                    response = append_response(response, &outcome.response);
                }
                // A clarification/confirmation is a hard conversational
                // boundary. Never continue later plan operations after asking
                // the user for a choice, even if the model emitted more steps.
                if state
                    .control
                    .pending(&invocation.target_workspace_id)
                    .is_some()
                {
                    receipts.push(StepExecutionReceipt {
                        operation: step.operation.clone(),
                        status: "paused",
                        target: outcome
                            .target
                            .clone()
                            .or_else(|| step.target.clone().or_else(|| step.provider.clone())),
                        message: outcome.response,
                        recipient: outcome.recipient,
                        stages: outcome.stages,
                    });
                    state.control.replace_plan(
                        &invocation.target_workspace_id,
                        operations[index..].to_vec(),
                    );
                    break;
                }
                receipts.push(StepExecutionReceipt {
                    operation: step.operation.clone(),
                    status: outcome.status,
                    target: outcome
                        .target
                        .clone()
                        .or_else(|| step.target.clone().or_else(|| step.provider.clone())),
                    message: outcome.response,
                    recipient: outcome.recipient,
                    stages: outcome.stages,
                });
            }
            Err(step_error) => {
                let brief = brief_control_error(&step_error);
                let stages = dispatch_failure_stages(&step_error);
                response = append_response(response, &brief);
                warnings.push("plan_step_failed".to_string());
                receipts.push(StepExecutionReceipt {
                    operation: step.operation.clone(),
                    status: dispatch_failure_status(&step_error),
                    target: step.target.clone().or_else(|| step.provider.clone()),
                    message: step_error,
                    recipient: None,
                    stages,
                });
                if state
                    .control
                    .pending(&invocation.target_workspace_id)
                    .is_some()
                {
                    state.control.replace_plan(
                        &invocation.target_workspace_id,
                        operations[index..].to_vec(),
                    );
                    break;
                }
                if !matches!(
                    step.operation,
                    PlanOperation::AgentSend | PlanOperation::AgentOpen
                ) {
                    break;
                }
            }
        }
    }

    if response.trim().is_empty() {
        response = "Fatto.".to_string();
    }
    response = compact_response(&response);
    ControlExecution {
        response,
        warnings,
        steps: receipts,
    }
}

async fn refresh_operational_context(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    base: &crate::jarvis::types::ModelContextViewV1,
) -> Result<crate::jarvis::types::ModelContextViewV1, String> {
    crate::jarvis::commands::reconcile_live_registry(app, &now()).await;
    let terminals =
        list_terminals_for_workspace(&app.state::<TerminalManager>(), workspace, &now()).await;
    let state = app.state::<crate::jarvis::JarvisState>();
    let mut sessions = JarvisToolService::new(&state.broker)
        .agent_snapshot(
            &invocation.target_workspace_id,
            Some(invocation.request_id.clone()),
            &now(),
        )
        .map_err(|error| error.message)?
        .data;
    attach_terminal_titles(&mut sessions, &terminals);
    let mut context = base.clone();
    context.terminals = terminals;
    context.agent_sessions = sessions;
    Ok(context)
}

fn append_response(current: String, message: &str) -> String {
    if current.trim().is_empty() {
        message.to_string()
    } else if message.trim().is_empty() {
        current
    } else {
        format!("{current} {message}")
    }
}

fn brief_control_error(error: &str) -> String {
    if error.starts_with("turn_failed:") {
        return "Invio agente non riuscito; il destinatario non è confermato.".to_string();
    }
    compact_response(error)
}

fn dispatch_failure_status(error: &str) -> &'static str {
    if error.starts_with("turn_failed:") {
        DISPATCH_TURN_FAILED
    } else {
        "failed"
    }
}

fn dispatch_failure_stages(error: &str) -> Vec<&'static str> {
    if error.starts_with("turn_failed:") {
        vec![DISPATCH_TURN_FAILED]
    } else {
        Vec::new()
    }
}

fn should_parallelize_agent_sends(operations: &[ConversationStep]) -> bool {
    operations.len() > 1
        && operations
            .iter()
            .all(|step| step.operation == PlanOperation::AgentSend)
}

async fn prepare_parallel_agent_sends(
    app: &AppHandle,
    context: &crate::jarvis::types::ModelContextViewV1,
    operations: &[ConversationStep],
) -> Option<Vec<(ConversationStep, ResolvedAgentTarget, String)>> {
    let mut prepared = Vec::with_capacity(operations.len());
    let mut terminal_ids = HashSet::new();
    for step in operations {
        let resolution = resolve_target(
            app,
            context,
            step.target.as_deref(),
            step.provider.as_deref(),
        )
        .await;
        let TargetResolution::Selected(target) = resolution else {
            return None;
        };
        if is_busy(&target.session) || !terminal_ids.insert(target.terminal.terminal_id.clone()) {
            return None;
        }
        let prompt = validate_agent_text(step.prompt.as_deref().unwrap_or_default()).ok()?;
        prepared.push((step.clone(), target, prompt));
    }
    Some(prepared)
}

fn operations_for_execution(
    plan: &ConversationalPlan,
    pending: Option<&PendingConversationalIntent>,
) -> (Vec<ConversationStep>, bool) {
    let Some(pending) = pending else {
        return (plan.operations.clone(), false);
    };
    let Some(first) = plan.operations.first() else {
        return (plan.operations.clone(), false);
    };
    let resumes = pending.operation == first.operation
        || (first.operation == PlanOperation::AgentOpen
            && matches!(
                pending.operation,
                PlanOperation::AgentSend | PlanOperation::AgentHandoff
            ));
    if !resumes {
        return (plan.operations.clone(), false);
    }

    // Keep the user's fresh step intact here; `execute_step` merges omitted
    // fields only for execution, while routing safety must still distinguish
    // an explicit new target from fields restored from the pending intent.
    let mut operations = vec![first.clone()];
    operations.extend(pending.plan.operations.iter().skip(1).cloned());
    (operations, true)
}

fn validate_agent_dispatches(operations: &[ConversationStep]) -> Result<(), String> {
    let sends = operations
        .iter()
        .filter(|step| step.operation == PlanOperation::AgentSend)
        .collect::<Vec<_>>();
    if sends.len() <= 1 {
        return Ok(());
    }
    if sends.iter().any(|step| {
        step.provider
            .as_deref()
            .is_none_or(|provider| provider.trim().is_empty())
            && step
                .target
                .as_deref()
                .is_none_or(|target| target.trim().is_empty())
    }) {
        return Err(
            "Non invio il piano multi-agente: ogni task deve indicare esplicitamente il proprio agente (per esempio PI o Codex).".to_string(),
        );
    }
    Ok(())
}

async fn execute_step(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    reserved_terminal_ids: &mut HashSet<String>,
    incoming_step: &ConversationStep,
) -> Result<StepExecutionOutcome, String> {
    // The current turn carries the new choice (provider, confirmed,
    // allowBusy), while the exact pending state preserves omitted semantic
    // fields from the previous turn. This lets short answers such as “sì”,
    // “usa quello” or “Codex” safely continue the dialogue.
    let step = merge_step_with_pending(incoming_step, pending);
    let step = &step;

    match step.operation {
        PlanOperation::Respond => Ok(plain_outcome(
            step.prompt
                .clone()
                .or_else(|| Some("Dimmi pure.".to_string()))
                .unwrap_or_default(),
        )),
        PlanOperation::Clarify => {
            let question = step
                .prompt
                .clone()
                .or_else(|| Some("Mi serve un dettaglio in più.".to_string()))
                .unwrap_or_default();
            put_clarification(app, invocation, step, question.clone());
            Ok(StepExecutionOutcome {
                response: question,
                status: "paused",
                target: None,
                recipient: None,
                stages: Vec::new(),
            })
        }
        PlanOperation::DraftPrompt => Ok(plain_outcome(step.prompt.clone().unwrap_or_default())),
        PlanOperation::AgentReport => Ok(plain_outcome(build_agent_report(context))),
        PlanOperation::AgentOpen => {
            let initial_prompt = if step
                .source
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                // This path is used when the user answered a busy-handoff
                // clarification with “open a new agent”. Preserve the original
                // source and rebuild the bounded handoff instead of sending
                // only the short instruction to the new provider.
                let source = resolve_target(app, context, step.source.as_deref(), None).await;
                let source = target_or_clarify(
                    app,
                    invocation,
                    step,
                    source,
                    "leggere la sorgente dell'handoff",
                )?;
                let evidence = source_evidence(app, &source).await?;
                Some(build_handoff_prompt(
                    &source,
                    &evidence,
                    step.prompt.as_deref().unwrap_or_default(),
                )?)
            } else {
                step.prompt.clone().filter(|value| !value.trim().is_empty())
            };
            let Some(provider) = step.provider.as_deref().and_then(normalize_plan_provider) else {
                let question = "Quale agente vuoi aprire?".to_string();
                put_clarification(app, invocation, step, question.clone());
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: None,
                    recipient: None,
                    stages: Vec::new(),
                });
            };
            let opened = open_agent(app, workspace, invocation, &provider, initial_prompt).await?;
            Ok(match opened {
                OpenResult::Opened {
                    provider,
                    sent,
                    agent_alias,
                    dispatch,
                    ..
                } => {
                    if let Some(dispatch) = dispatch {
                        StepExecutionOutcome {
                            response: format!(
                                "Aperto {agent_alias}; task scritta, avvio del turno non confermato."
                            ),
                            status: dispatch.status,
                            target: Some(agent_alias),
                            recipient: Some(dispatch.recipient),
                            stages: dispatch.stages,
                        }
                    } else {
                        StepExecutionOutcome {
                            response: if sent {
                                format!("Fatto, ho aperto {provider}.")
                            } else {
                                format!("Fatto, ho aperto {provider}.")
                            },
                            status: "succeeded",
                            target: Some(agent_alias),
                            recipient: None,
                            stages: Vec::new(),
                        }
                    }
                }
            })
        }
        PlanOperation::AgentSend => {
            let prompt = validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                .map_err(|_| "Non ho inviato il task: il prompt non è valido.".to_string())?;
            let no_explicit_target = incoming_step
                .target
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
                && incoming_step
                    .provider
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty());
            let resolution = if let Some(target) =
                bound_target_from_pending(context, pending, step, incoming_step)?
            {
                TargetResolution::Selected(target)
            } else if no_explicit_target {
                let binding = app
                    .state::<crate::jarvis::JarvisState>()
                    .control
                    .last_assignment(&invocation.target_workspace_id);
                let Some(binding) = binding else {
                    let question =
                        "Non ho un binding attivo per questo follow-up. Indica l'alias dell'agente, per esempio codex-2.".to_string();
                    put_clarification(app, invocation, step, question.clone());
                    return Ok(StepExecutionOutcome {
                        response: question,
                        status: "paused",
                        target: None,
                        recipient: None,
                        stages: Vec::new(),
                    });
                };
                TargetResolution::Selected(target_from_binding(context, &binding)?)
            } else {
                resolve_target(
                    app,
                    context,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await
            };
            if resolution == TargetResolution::NotFound {
                if let Some(provider) = step.provider.as_deref().and_then(normalize_plan_provider) {
                    let opened =
                        open_agent(app, workspace, invocation, &provider, Some(prompt.clone()))
                            .await?;
                    return Ok(plain_outcome(match opened {
                        OpenResult::Opened { provider, .. } => {
                            format!("Fatto, ho aperto {provider} e gli ho inviato la task.")
                        }
                    }));
                }
            }
            let target = target_or_clarify(app, invocation, step, resolution, "inviare la task")?;
            reject_reused_target(&reserved_terminal_ids, &target)?;
            if is_busy(&target.session) && !busy_override_matches(pending, step, &target) {
                let label = target_label(&target);
                let question = format!(
                    "{label} sta ancora lavorando. Vuoi che gli aggiunga questa task o preferisci aprire un nuovo agente?"
                );
                put_confirmation_like_clarification(
                    app,
                    invocation,
                    step,
                    &target,
                    question.clone(),
                );
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: Some(label),
                    recipient: None,
                    stages: Vec::new(),
                });
            }
            let binding = if no_explicit_target {
                pending
                    .and_then(|intent| intent.binding.clone())
                    .or_else(|| {
                        app.state::<crate::jarvis::JarvisState>()
                            .control
                            .last_assignment(&invocation.target_workspace_id)
                    })
            } else {
                None
            };
            let dispatch = send_to_target(app, invocation, &target, &prompt, binding).await?;
            app.state::<crate::jarvis::JarvisState>()
                .control
                .record_assignment(&invocation.target_workspace_id, dispatch.binding.clone());
            reserved_terminal_ids.insert(target.terminal.terminal_id.clone());
            Ok(StepExecutionOutcome {
                response: if dispatch.status == DISPATCH_SUBMISSION_UNCONFIRMED {
                    format!(
                        "Scritto a {}; avvio del turno non confermato.",
                        target_label(&target)
                    )
                } else {
                    format!("Fatto, l'ho inviato a {}.", target_label(&target))
                },
                status: dispatch.status,
                target: Some(target_label(&target)),
                recipient: Some(dispatch.recipient),
                stages: dispatch.stages,
            })
        }
        PlanOperation::AgentHandoff => {
            let source = resolve_target(app, context, step.source.as_deref(), None).await;
            let source = target_or_clarify(
                app,
                invocation,
                step,
                source,
                "leggere la sorgente dell'handoff",
            )?;
            let destination = if let Some(target) =
                bound_target_from_pending(context, pending, step, incoming_step)?
            {
                TargetResolution::Selected(target)
            } else {
                resolve_target(
                    app,
                    context,
                    step.destination.as_deref().or(step.target.as_deref()),
                    step.provider.as_deref(),
                )
                .await
            };
            let destination =
                target_or_clarify(app, invocation, step, destination, "inviare l'handoff")?;
            reject_reused_target(&reserved_terminal_ids, &destination)?;
            if is_busy(&destination.session) && !busy_override_matches(pending, step, &destination)
            {
                let question = format!(
                    "{} sta ancora lavorando. Vuoi aggiungere l'handoff o aprire un nuovo agente?",
                    target_label(&destination)
                );
                put_confirmation_like_clarification(
                    app,
                    invocation,
                    step,
                    &destination,
                    question.clone(),
                );
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: Some(target_label(&destination)),
                    recipient: None,
                    stages: Vec::new(),
                });
            }
            let evidence = source_evidence(app, &source).await?;
            let prompt = build_handoff_prompt(
                &source,
                &evidence,
                step.prompt.as_deref().unwrap_or_default(),
            )?;
            let binding = pending.and_then(|intent| intent.binding.clone());
            let dispatch = send_to_target(app, invocation, &destination, &prompt, binding).await?;
            app.state::<crate::jarvis::JarvisState>()
                .control
                .record_assignment(&invocation.target_workspace_id, dispatch.binding.clone());
            reserved_terminal_ids.insert(destination.terminal.terminal_id.clone());
            Ok(StepExecutionOutcome {
                response: format!(
                    "Scritto a {}; avvio del turno non confermato.",
                    target_label(&destination)
                ),
                status: dispatch.status,
                target: Some(target_label(&destination)),
                recipient: Some(dispatch.recipient),
                stages: dispatch.stages,
            })
        }
        PlanOperation::AgentAbort => {
            let resolution = if let Some(target) =
                bound_target_from_pending(context, pending, step, incoming_step)?
            {
                TargetResolution::Selected(target)
            } else {
                resolve_target(
                    app,
                    context,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await
            };
            let target = target_or_clarify(
                app,
                invocation,
                step,
                resolution,
                "interrompere la sessione",
            )?;
            if is_busy(&target.session) && !confirmation_matches(pending, step, &target) {
                let question = format!(
                    "{} sta ancora lavorando. Lo interrompo comunque?",
                    target_label(&target)
                );
                put_confirmation(app, invocation, step, &target, question.clone());
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: Some(target_label(&target)),
                    recipient: None,
                    stages: Vec::new(),
                });
            }
            let snapshot = fresh_snapshot(app, invocation, &target).await?;
            app.state::<TerminalManager>()
                .write_typed_for_generation(
                    app,
                    &target.terminal.terminal_id,
                    snapshot.generation,
                    &[0x03],
                    TerminalInputOrigin::JarvisAbort,
                )
                .await
                .map_err(|_| "Non sono riuscito a interrompere l'agente.".to_string())?;
            let _ = snapshot;
            Ok(plain_outcome(format!(
                "Fatto, ho interrotto {}.",
                target_label(&target)
            )))
        }
        PlanOperation::TerminalClose => {
            let resolution = if let Some(target) =
                bound_target_from_pending(context, pending, step, incoming_step)?
            {
                TargetResolution::Selected(target)
            } else {
                resolve_target(
                    app,
                    context,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await
            };
            let target =
                target_or_clarify(app, invocation, step, resolution, "chiudere la sessione")?;
            if is_busy(&target.session) && !confirmation_matches(pending, step, &target) {
                let question = format!(
                    "{} sta ancora lavorando. Lo chiudo comunque?",
                    target_label(&target)
                );
                put_confirmation(app, invocation, step, &target, question.clone());
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: Some(target_label(&target)),
                    recipient: None,
                    stages: Vec::new(),
                });
            }
            close_target(app, workspace, invocation, &target).await?;
            Ok(plain_outcome(format!(
                "Fatto, ho chiuso {}.",
                target_label(&target)
            )))
        }
        PlanOperation::TerminalRestart => {
            let resolution = if let Some(target) =
                bound_target_from_pending(context, pending, step, incoming_step)?
            {
                TargetResolution::Selected(target)
            } else {
                resolve_target(
                    app,
                    context,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await
            };
            let target =
                target_or_clarify(app, invocation, step, resolution, "riavviare la sessione")?;
            if is_busy(&target.session) && !confirmation_matches(pending, step, &target) {
                let question = format!(
                    "{} sta ancora lavorando. Lo riavvio comunque?",
                    target_label(&target)
                );
                put_confirmation(app, invocation, step, &target, question.clone());
                return Ok(StepExecutionOutcome {
                    response: question,
                    status: "paused",
                    target: Some(target_label(&target)),
                    recipient: None,
                    stages: Vec::new(),
                });
            }
            restart_target(app, workspace, invocation, &target).await?;
            Ok(plain_outcome(format!(
                "Fatto, ho riavviato {}.",
                target_label(&target)
            )))
        }
    }
}

fn merge_step_with_pending(
    current: &ConversationStep,
    pending: Option<&PendingConversationalIntent>,
) -> ConversationStep {
    let mut merged = current.clone();
    let Some(intent) = pending else {
        return merged;
    };
    let Some(previous) = intent.plan.operations.first() else {
        return merged;
    };

    if intent.operation == current.operation {
        if merged.provider.is_none() {
            merged.provider = previous.provider.clone();
        }
        if merged.target.as_deref().is_none_or(str::is_empty) {
            merged.target = previous.target.clone();
        }
        if merged.source.as_deref().is_none_or(str::is_empty) {
            merged.source = previous.source.clone();
        }
        if merged.destination.as_deref().is_none_or(str::is_empty) {
            merged.destination = previous.destination.clone();
        }
        if merged.prompt.as_deref().is_none_or(str::is_empty) {
            merged.prompt = previous.prompt.clone();
        }
    } else if current.operation == PlanOperation::AgentOpen
        && matches!(
            intent.operation,
            PlanOperation::AgentSend | PlanOperation::AgentHandoff
        )
    {
        // “Aprine uno nuovo” after a busy-target question must not lose the
        // task that triggered the clarification. Handoffs also keep their
        // source so AgentOpen can rebuild bounded evidence for the new agent.
        if merged.prompt.as_deref().is_none_or(str::is_empty) {
            merged.prompt = previous.prompt.clone();
        }
        if intent.operation == PlanOperation::AgentHandoff
            && merged.source.as_deref().is_none_or(str::is_empty)
        {
            merged.source = previous.source.clone();
        }
    }
    merged
}

fn binding_for_target(target: &ResolvedAgentTarget) -> AgentAssignmentBinding {
    let alias = target
        .terminal
        .agent_alias
        .clone()
        .or_else(|| target.session.reference.agent_alias.clone())
        .unwrap_or_else(|| format!("terminal-{}", target.terminal.terminal_id));
    AgentAssignmentBinding {
        assignment_id: new_assignment_id(),
        agent_alias: alias,
        agent_session_id: target.session.reference.agent_session_id.clone(),
        terminal_id: target.terminal.terminal_id.clone(),
        generation: target.terminal.generation,
        process_id: target.terminal.process_id,
        provider: target.session.resolved_provider.clone(),
        provider_session_id: target.session.reference.provider_session_id.clone(),
    }
}

fn recipient_from_target(
    binding: &AgentAssignmentBinding,
    target: &ResolvedAgentTarget,
) -> AgentRecipientReceipt {
    AgentRecipientReceipt {
        assignment_id: binding.assignment_id.clone(),
        agent_alias: binding.agent_alias.clone(),
        agent_session_id: binding.agent_session_id.clone(),
        terminal_id: binding.terminal_id.clone(),
        generation: binding.generation,
        process_id: binding.process_id,
        provider: binding.provider.clone(),
        provider_session_id: binding.provider_session_id.clone(),
        display_title: target.terminal.title.clone(),
    }
}

fn target_from_binding(
    context: &crate::jarvis::types::ModelContextViewV1,
    binding: &AgentAssignmentBinding,
) -> Result<ResolvedAgentTarget, String> {
    let terminal = context
        .terminals
        .iter()
        .find(|terminal| {
            terminal.workspace_id == context.invocation.target_workspace_id
                && terminal.terminal_id == binding.terminal_id
                && terminal.generation == binding.generation
                && binding
                    .process_id
                    .is_none_or(|process_id| terminal.process_id == Some(process_id))
                && terminal.process_alive
                && terminal.agent_alias.as_deref() == Some(binding.agent_alias.as_str())
        })
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    let session = context
        .agent_sessions
        .iter()
        .find(|session| {
            session.reference.agent_session_id == binding.agent_session_id
                && session.reference.workspace_id == context.invocation.target_workspace_id
                && session.reference.terminal_id.as_deref() == Some(binding.terminal_id.as_str())
                && session.reference.generation == binding.generation
                && session.reference.agent_alias.as_deref() == Some(binding.agent_alias.as_str())
                && session.reference.resolved_provider == binding.provider
                && (binding.provider_session_id.is_none()
                    || session.reference.provider_session_id == binding.provider_session_id)
                && session.state != AgentState::Exited
        })
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    Ok(ResolvedAgentTarget {
        terminal: terminal.clone(),
        session: session.clone(),
    })
}

fn bound_target_from_pending(
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
    incoming_step: &ConversationStep,
) -> Result<Option<ResolvedAgentTarget>, String> {
    if !step.confirmed && !step.allow_busy {
        return Ok(None);
    }
    // An explicit provider/target in the new turn is a new routing choice;
    // never let the old confirmation silently override “Codex” with the
    // previously pending PI target.
    if incoming_step
        .provider
        .as_deref()
        .is_some_and(|provider| !provider.trim().is_empty())
        || incoming_step
            .target
            .as_deref()
            .is_some_and(|target| !target.trim().is_empty())
    {
        return Ok(None);
    }
    let Some(pending) = pending else {
        return Ok(None);
    };
    if pending.operation != step.operation {
        return Ok(None);
    }
    let binding = pending
        .binding
        .as_ref()
        .ok_or_else(|| "agent_binding_missing".to_string())?;
    target_from_binding(context, binding).map(Some)
}

fn target_or_clarify(
    app: &AppHandle,
    invocation: &InvocationBinding,
    step: &ConversationStep,
    resolution: TargetResolution,
    action: &str,
) -> Result<ResolvedAgentTarget, String> {
    match resolution {
        TargetResolution::Selected(target) => Ok(target),
        TargetResolution::NotFound => Err(format!("Non ho trovato un agente da {action}.")),
        TargetResolution::Ambiguous(options) => {
            let question = match options.as_slice() {
                [] => "Quale agente vuoi usare?".to_string(),
                [only] => format!("Intendi {only} per {action}?"),
                _ => format!("Quale agente vuoi usare: {}?", options.join(", ")),
            };
            put_clarification(app, invocation, step, question.clone());
            Err(question)
        }
    }
}

fn reject_reused_target(
    reserved_terminal_ids: &HashSet<String>,
    target: &ResolvedAgentTarget,
) -> Result<(), String> {
    if reserved_terminal_ids.contains(&target.terminal.terminal_id) {
        return Err(format!(
            "Non ho inviato il task a {}: il piano indicava già questo stesso agente. Specifica il target distinto, per esempio Codex o PI.",
            target_label(target)
        ));
    }
    Ok(())
}

async fn resolve_target(
    app: &AppHandle,
    context: &crate::jarvis::types::ModelContextViewV1,
    query: Option<&str>,
    provider: Option<&str>,
) -> TargetResolution {
    let explicit_provider = provider.and_then(normalize_plan_provider);
    let query_text = query.unwrap_or_default().trim();
    let query_provider = if query_text.is_empty() {
        None
    } else {
        normalize_plan_provider(query_text)
    };
    // The internal alias is the only exact semantic identity. A matching
    // alias bypasses title/task scoring, while duplicate/corrupt aliases are
    // surfaced as ambiguous instead of selecting by iteration order.
    if !query_text.is_empty() {
        let alias_matches = context
            .agent_sessions
            .iter()
            .filter_map(|session| {
                let alias = session.reference.agent_alias.as_deref()?;
                if !alias.eq_ignore_ascii_case(query_text) || session.state == AgentState::Exited {
                    return None;
                }
                let terminal = context.terminals.iter().find(|terminal| {
                    terminal.terminal_id
                        == session.reference.terminal_id.as_deref().unwrap_or_default()
                        && terminal.generation == session.reference.generation
                        && terminal.workspace_id == context.invocation.target_workspace_id
                        && terminal.process_alive
                        && terminal.agent_alias.as_deref() == Some(alias)
                })?;
                Some(ResolvedAgentTarget {
                    terminal: terminal.clone(),
                    session: session.clone(),
                })
            })
            .collect::<Vec<_>>();
        if alias_matches.len() == 1 {
            return TargetResolution::Selected(alias_matches.into_iter().next().unwrap());
        }
        if alias_matches.len() > 1 {
            return TargetResolution::Ambiguous(
                alias_matches.iter().map(target_label).take(4).collect(),
            );
        }
    }
    // If the semantic query is only a provider name ("Codex"), constrain to
    // that provider first. With multiple sessions of the same provider this
    // remains ambiguous; availability alone is not enough to guess which pane
    // the user meant.
    let provider_filter = explicit_provider.clone().or(query_provider.clone());
    let mut candidates = context
        .agent_sessions
        .iter()
        .filter_map(|session| {
            let terminal_id = session.reference.terminal_id.as_ref()?;
            let terminal = context.terminals.iter().find(|terminal| {
                &terminal.terminal_id == terminal_id
                    && terminal.generation == session.reference.generation
            })?;
            if terminal.workspace_id != context.invocation.target_workspace_id {
                return None;
            }
            if !terminal.process_alive || session.state == AgentState::Exited {
                return None;
            }
            if provider_filter.as_deref().is_some_and(|value| {
                value != session.resolved_provider && value != session.reference.provider
            }) {
                return None;
            }
            Some((
                score_candidate(query_text, session, terminal, provider_filter.as_deref()),
                session,
                terminal,
            ))
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return TargetResolution::NotFound;
    }

    // An omitted target is never permission to guess. In particular, when a
    // multi-agent plan loses the provider field, choosing the only/most idle
    // candidate can silently route a Codex task to PI. Force an explicit
    // semantic choice instead.
    if query_text.is_empty() && explicit_provider.is_none() {
        return TargetResolution::Ambiguous(
            candidates
                .iter()
                .take(4)
                .map(|(_, session, terminal)| display_candidate(session, terminal))
                .collect(),
        );
    }

    let query_is_provider_only = query_provider.is_some();
    if candidates.len() > 1 && (query_text.is_empty() || query_is_provider_only) {
        return TargetResolution::Ambiguous(
            candidates
                .iter()
                .take(4)
                .map(|(_, session, terminal)| display_candidate(session, terminal))
                .collect(),
        );
    }

    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    let top_score = candidates[0].0;
    if candidates.len() > 1 && candidates[1].0 == top_score {
        let mut with_tail = Vec::new();
        for (_, session, terminal) in candidates.iter().take(4) {
            if let Ok(tail) = read_agent_tail(app, terminal, DEFAULT_TAIL_LINES).await {
                let tail_score = token_overlap(query_text, &tail.content);
                with_tail.push((tail_score, *session, *terminal));
            }
        }
        with_tail.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
        if with_tail.first().is_some_and(|item| item.0 > 0)
            && with_tail.get(1).map(|item| item.0).unwrap_or(-1) < with_tail[0].0
        {
            return TargetResolution::Selected(ResolvedAgentTarget {
                terminal: with_tail[0].2.clone(),
                session: with_tail[0].1.clone(),
            });
        }
        return TargetResolution::Ambiguous(
            candidates
                .iter()
                .take(4)
                .map(|(_, session, terminal)| display_candidate(session, terminal))
                .collect(),
        );
    }
    if top_score <= 0 && !query_text.is_empty() {
        return TargetResolution::Ambiguous(
            candidates
                .iter()
                .take(4)
                .map(|(_, session, terminal)| display_candidate(session, terminal))
                .collect(),
        );
    }
    TargetResolution::Selected(ResolvedAgentTarget {
        terminal: candidates[0].2.clone(),
        session: candidates[0].1.clone(),
    })
}

fn score_candidate(
    query: &str,
    session: &AgentSessionContext,
    terminal: &TerminalSummary,
    provider: Option<&str>,
) -> i32 {
    let query = query.trim().to_ascii_lowercase();
    let mut score = 0;
    if provider.is_some_and(|value| value == session.resolved_provider) {
        score += 100;
    }
    // When semantic relevance is otherwise comparable, prefer a reusable
    // waiting/completed session over one already in the middle of work.
    score += match session.state {
        AgentState::Waiting => 15,
        AgentState::Completed => 12,
        AgentState::Exited => -100,
        _ => 0,
    };
    if query.is_empty() {
        return score;
    }
    let title = terminal.title.to_ascii_lowercase();
    let alias = terminal
        .agent_alias
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let provider_name = session.resolved_provider.to_ascii_lowercase();
    if title.contains(&query) {
        score += 80;
    }
    if alias == query {
        score += 1_000;
    } else if alias.contains(&query) {
        score += 160;
    }
    if provider_name == query || query.contains(&provider_name) {
        score += 70;
    }
    score += token_overlap(&query, &title) * 12;
    if let Some(task) = &session.current_task {
        score += token_overlap(&query, &task.text) * 10;
    }
    if let Some(result) = &session.last_result {
        score += token_overlap(&query, &result.content) * 3;
    }
    score
}

fn token_overlap(left: &str, right: &str) -> i32 {
    let right = right.to_ascii_lowercase();
    left.split(|character: char| !character.is_alphanumeric())
        .filter(|token| token.len() >= 2 && right.contains(token))
        .count() as i32
}

fn display_candidate(session: &AgentSessionContext, terminal: &TerminalSummary) -> String {
    let title =
        if terminal.title.trim().is_empty() || terminal.title.eq_ignore_ascii_case("terminal") {
            provider_display_name(&session.resolved_provider)
        } else {
            terminal.title.clone()
        };
    if let Some(alias) = terminal
        .agent_alias
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return format!("{alias} — {title}");
    }
    title
}

fn target_label(target: &ResolvedAgentTarget) -> String {
    display_candidate(&target.session, &target.terminal)
}

fn is_busy(session: &AgentSessionContext) -> bool {
    matches!(session.state, AgentState::Starting | AgentState::Working)
}

async fn read_agent_tail(
    app: &AppHandle,
    terminal: &TerminalSummary,
    max_lines: usize,
) -> Result<AgentTail, String> {
    // Internal tail reads must be as stale-safe as the public command. An old
    // model context may outlive a restart that reused the terminal id.
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(&terminal.terminal_id)
        .await
        .map_err(|_| "tail terminale non disponibile".to_string())?
        .ok_or_else(|| "tail terminale non disponibile".to_string())?;
    if snapshot.workspace_id != terminal.workspace_id
        || snapshot.generation != terminal.generation
        || snapshot.process_id != terminal.process_id
        || !snapshot.is_agent_terminal
    {
        return Err("tail terminale non disponibile: sessione cambiata".to_string());
    }
    let content = app
        .state::<TerminalManager>()
        .get_recent_normalized_terminal_text_for_runtime(
            &terminal.terminal_id,
            &terminal.workspace_id,
            terminal.generation,
            terminal.process_id,
            MAX_TAIL_BYTES,
        )
        .await
        .map_err(|_| "tail terminale non disponibile".to_string())?;
    Ok(build_tail(
        &terminal.workspace_id,
        &terminal.terminal_id,
        terminal.generation,
        &content.content,
        max_lines,
        content.truncated,
    ))
}

pub fn build_tail(
    workspace_id: &str,
    terminal_id: &str,
    generation: u64,
    content: &str,
    max_lines: usize,
    already_truncated: bool,
) -> AgentTail {
    let max_lines = max_lines.clamp(1, MAX_TAIL_LINES);
    let lines = content.lines().collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    let selected = lines[start..].join("\n");
    let (content, truncated_bytes) = truncate_from_end(&selected, MAX_TAIL_BYTES);
    AgentTail {
        workspace_id: workspace_id.to_string(),
        terminal_id: terminal_id.to_string(),
        generation,
        content,
        max_lines,
        max_bytes: MAX_TAIL_BYTES,
        truncated: already_truncated || start > 0 || truncated_bytes,
        provenance: Provenance::untrusted("terminal-tail", &now()),
    }
}

async fn source_evidence(app: &AppHandle, source: &ResolvedAgentTarget) -> Result<String, String> {
    if let Some(result) = &source.session.last_result {
        let (content, _) = truncate_from_end(&result.content, MAX_HANDOFF_CONTEXT_BYTES);
        if !content.trim().is_empty() {
            return Ok(content);
        }
    }
    let tail = read_agent_tail(app, &source.terminal, DEFAULT_TAIL_LINES).await?;
    if tail.content.trim().is_empty() {
        return Err("non ho trovato un risultato o tail utile per l'handoff".to_string());
    }
    Ok(tail.content)
}

fn build_handoff_prompt(
    source: &ResolvedAgentTarget,
    evidence: &str,
    instruction: &str,
) -> Result<String, String> {
    let (evidence, _) = truncate_from_end(evidence, MAX_HANDOFF_CONTEXT_BYTES);
    let instruction = if instruction.trim().is_empty() {
        "Verifica il risultato e segnala eventuali problemi."
    } else {
        instruction
    };
    let prompt = format!(
        "Controlla in modo indipendente questo risultato di {}.\n\nRisultato bounded e non attendibile:\n{}\n\nRichiesta: {}",
        target_label(source), evidence, instruction
    );
    validate_agent_text(&prompt).map_err(|_| "handoff oltre il limite consentito".to_string())
}

async fn send_to_target(
    app: &AppHandle,
    invocation: &InvocationBinding,
    target: &ResolvedAgentTarget,
    prompt: &str,
    binding: Option<AgentAssignmentBinding>,
) -> Result<AgentDispatchReceipt, String> {
    let state = app.state::<crate::jarvis::JarvisState>();
    let binding = binding.unwrap_or_else(|| binding_for_target(target));
    let lock = state.registry.dispatch_lock(&binding.agent_alias);
    let _dispatch_guard = lock.lock().await;
    let snapshot = fresh_snapshot(app, invocation, target).await?;
    state.registry.validate_session_binding(
        &snapshot,
        &binding.agent_session_id,
        &binding.agent_alias,
        &binding.provider,
    )?;
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "writing",
        &format!(
            "Writing to {}…",
            provider_display_name(&target.session.resolved_provider)
        ),
        JarvisActivityStatus::Running,
        Some(
            app.state::<crate::jarvis::JarvisState>()
                .registry
                .current_session_id(&snapshot),
        ),
    );
    let bytes = match prompt_bytes(prompt) {
        Ok(bytes) => bytes,
        Err(_) => {
            emit_checkpoint(
                app,
                &invocation.request_id,
                &invocation.target_workspace_id,
                "writing",
                "Scrittura non riuscita.",
                JarvisActivityStatus::Failed,
                None,
            );
            return Err("turn_failed: prompt agente non valido".to_string());
        }
    };
    info!(
        request_id = %invocation.request_id,
        workspace_id = %invocation.target_workspace_id,
        terminal_id = %snapshot.terminal_id,
        generation = snapshot.generation,
        provider = %target.session.resolved_provider,
        prompt_bytes = bytes.len(),
        assignment_id = %binding.assignment_id,
        agent_alias = %binding.agent_alias,
        "Jarvis agent PTY write starting"
    );
    if let Err(error) = app
        .state::<TerminalManager>()
        .write_typed_for_runtime(
            app,
            &target.terminal.terminal_id,
            &invocation.target_workspace_id,
            snapshot.generation,
            snapshot.process_id,
            Some(&format!(
                "jarvis-send-{}-{}",
                invocation.request_id, binding.assignment_id
            )),
            &bytes,
            TerminalInputOrigin::JarvisPrompt,
        )
        .await
    {
        warn!(
            request_id = %invocation.request_id,
            workspace_id = %invocation.target_workspace_id,
            terminal_id = %snapshot.terminal_id,
            generation = snapshot.generation,
            provider = %target.session.resolved_provider,
            %error,
            "Jarvis agent PTY write failed"
        );
        emit_checkpoint(
            app,
            &invocation.request_id,
            &invocation.target_workspace_id,
            "writing",
            "Scrittura non riuscita.",
            JarvisActivityStatus::Failed,
            None,
        );
        return Err(format!(
            "turn_failed: non sono riuscito a scrivere nella PTY: {error}"
        ));
    }
    info!(
        request_id = %invocation.request_id,
        workspace_id = %invocation.target_workspace_id,
        terminal_id = %snapshot.terminal_id,
        generation = snapshot.generation,
        provider = %target.session.resolved_provider,
        "Jarvis agent PTY write succeeded"
    );
    state.registry.observe_jarvis_send_for_session(
        &snapshot,
        &binding.agent_session_id,
        prompt,
        &now(),
    )?;
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "writing",
        "Scritto; avvio turno non confermato.",
        JarvisActivityStatus::Running,
        None,
    );
    Ok(AgentDispatchReceipt {
        status: DISPATCH_SUBMISSION_UNCONFIRMED,
        stages: unconfirmed_dispatch_stages(),
        recipient: recipient_from_target(&binding, target),
        binding,
    })
}

async fn fresh_snapshot(
    app: &AppHandle,
    invocation: &InvocationBinding,
    target: &ResolvedAgentTarget,
) -> Result<crate::jarvis::agent_registry::TerminalAgentSnapshot, String> {
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(&target.terminal.terminal_id)
        .await
        .map_err(|_| "terminale non disponibile".to_string())?
        .ok_or_else(|| "terminale non disponibile".to_string())?;
    if snapshot.workspace_id != invocation.target_workspace_id
        || snapshot.generation != target.terminal.generation
        || target
            .terminal
            .process_id
            .is_some_and(|process_id| snapshot.process_id != Some(process_id))
    {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    if !snapshot.process_alive || !snapshot.is_agent_terminal {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let alias = target
        .terminal
        .agent_alias
        .as_deref()
        .or(target.session.reference.agent_alias.as_deref())
        .ok_or_else(|| "agent_alias_missing".to_string())?;
    if snapshot.agent_alias.as_deref() != Some(alias)
        || app
            .state::<crate::jarvis::JarvisState>()
            .registry
            .current_session_id(&snapshot)
            != target.session.reference.agent_session_id
    {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let registry = &app.state::<crate::jarvis::JarvisState>().registry;
    if !registry.control_allowed(&snapshot.terminal_id, snapshot.generation) {
        return Err("agent_identity_unconfirmed".to_string());
    }
    registry.validate_session_binding(
        &snapshot,
        &target.session.reference.agent_session_id,
        alias,
        &target.session.resolved_provider,
    )?;
    Ok(snapshot)
}

fn put_clarification(
    app: &AppHandle,
    invocation: &InvocationBinding,
    step: &ConversationStep,
    question: String,
) {
    app.state::<crate::jarvis::JarvisState>()
        .control
        .put(PendingConversationalIntent {
            workspace_id: invocation.target_workspace_id.clone(),
            kind: PendingConversationKind::Clarification,
            question,
            operation: step.operation.clone(),
            terminal_id: None,
            generation: None,
            binding: None,
            created_at: now(),
            expires_at: (Utc::now()
                + chrono::Duration::from_std(PENDING_CONVERSATION_TTL).unwrap_or_default())
            .to_rfc3339(),
            plan: ConversationalPlan {
                operations: vec![step.clone()],
                response: None,
            },
        });
}

fn put_confirmation(
    app: &AppHandle,
    invocation: &InvocationBinding,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
    question: String,
) {
    app.state::<crate::jarvis::JarvisState>()
        .control
        .put(PendingConversationalIntent {
            workspace_id: invocation.target_workspace_id.clone(),
            kind: PendingConversationKind::Confirmation,
            question,
            operation: step.operation.clone(),
            terminal_id: Some(target.terminal.terminal_id.clone()),
            generation: Some(target.terminal.generation),
            binding: Some(binding_for_target(target)),
            created_at: now(),
            expires_at: (Utc::now()
                + chrono::Duration::from_std(PENDING_CONVERSATION_TTL).unwrap_or_default())
            .to_rfc3339(),
            plan: ConversationalPlan {
                operations: vec![step.clone()],
                response: None,
            },
        });
}

fn put_confirmation_like_clarification(
    app: &AppHandle,
    invocation: &InvocationBinding,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
    question: String,
) {
    app.state::<crate::jarvis::JarvisState>()
        .control
        .put(PendingConversationalIntent {
            workspace_id: invocation.target_workspace_id.clone(),
            kind: PendingConversationKind::Clarification,
            question,
            operation: step.operation.clone(),
            terminal_id: Some(target.terminal.terminal_id.clone()),
            generation: Some(target.terminal.generation),
            binding: Some(binding_for_target(target)),
            created_at: now(),
            expires_at: (Utc::now()
                + chrono::Duration::from_std(PENDING_CONVERSATION_TTL).unwrap_or_default())
            .to_rfc3339(),
            plan: ConversationalPlan {
                operations: vec![step.clone()],
                response: None,
            },
        });
}

fn confirmation_matches(
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
) -> bool {
    step.confirmed
        && pending.is_some_and(|intent| {
            intent.kind == PendingConversationKind::Confirmation
                && intent.operation == step.operation
                && intent
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding_matches_target(binding, target))
        })
}

fn busy_override_matches(
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
) -> bool {
    step.allow_busy
        && pending.is_some_and(|intent| {
            intent.kind == PendingConversationKind::Clarification
                && intent.operation == step.operation
                && intent
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding_matches_target(binding, target))
        })
}

fn binding_matches_target(binding: &AgentAssignmentBinding, target: &ResolvedAgentTarget) -> bool {
    let alias = target.terminal.agent_alias.as_deref().or(target
        .session
        .reference
        .agent_alias
        .as_deref());
    binding.terminal_id == target.terminal.terminal_id
        && binding.generation == target.terminal.generation
        && binding
            .process_id
            .is_none_or(|process_id| target.terminal.process_id == Some(process_id))
        && alias == Some(binding.agent_alias.as_str())
        && binding.agent_session_id == target.session.reference.agent_session_id
        && binding.provider == target.session.resolved_provider
        && (binding.provider_session_id.is_none()
            || binding.provider_session_id == target.session.reference.provider_session_id)
}

#[derive(Debug)]
enum OpenResult {
    Opened {
        provider: String,
        sent: bool,
        terminal_id: String,
        generation: u64,
        agent_alias: String,
        agent_session_id: String,
        dispatch: Option<AgentDispatchReceipt>,
    },
}

async fn live_workspace(
    app: &AppHandle,
    expected: &WorkspaceConfig,
    invocation: &InvocationBinding,
) -> Result<WorkspaceConfig, String> {
    if expected.id != invocation.target_workspace_id {
        return Err("workspace invocation non valida".to_string());
    }
    let current = app
        .state::<WorkspaceRegistry>()
        .get(&expected.id)
        .await
        .ok_or_else(|| "workspace non disponibile".to_string())?;
    if current.id != invocation.target_workspace_id {
        return Err("workspace invocation non valida".to_string());
    }
    Ok(current)
}

async fn open_agent(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    provider: &str,
    initial_prompt: Option<String>,
) -> Result<OpenResult, String> {
    let provider = normalize_plan_provider(provider)
        .ok_or_else(|| format!("provider non supportato: {provider}"))?;
    let definition = app
        .state::<crate::agent::registry::AgentRegistry>()
        .get_agent(&provider)
        .cloned()
        .ok_or_else(|| format!("provider non supportato: {provider}"))?;
    let workspace = live_workspace(app, workspace, invocation).await?;
    if workspace.terminals.len() >= 8 {
        return Err("limite di otto terminali raggiunto in questa workspace".to_string());
    }
    let terminal_id = format!(
        "jarvis-agent-{}-{}",
        Utc::now().timestamp_millis(),
        NEXT_AGENT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let shell = workspace
        .terminals
        .first()
        .map(|terminal| terminal.shell.clone())
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "powershell.exe".to_string());
    let agent_alias = allocate_agent_alias(&workspace, &provider);
    let config = TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id: Some(provider.clone()),
        command: Some(definition.command.clone()),
        cwd: workspace.root_path.clone(),
        title: automatic_agent_title(&definition.name, initial_prompt.as_deref()),
        agent_alias: Some(agent_alias.clone()),
        title_manual: false,
        workspace_id: Some(workspace.id.clone()),
    };
    let manager = app.state::<TerminalManager>();
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "opening_agent",
        &format!("Opening {}…", definition.name),
        JarvisActivityStatus::Running,
        None,
    );
    let mut checkpoint = CheckpointGuard::new(app, invocation, "opening_agent");
    manager
        .spawn(app.clone(), config.clone(), 100, 30)
        .await
        .map_err(|_| "non sono riuscito ad aprire il terminale dell'agente".to_string())?;
    let runtime = manager
        .runtime_identity(&terminal_id)
        .await
        .map_err(|_| "sessione agente non disponibile".to_string())?;
    if runtime.workspace_id.as_str() != workspace.id.as_str() {
        let _ = manager
            .kill_generation(app, &terminal_id, runtime.generation)
            .await;
        return Err("sessione agente associata alla workspace sbagliata".to_string());
    }
    manager
        .set_backend_agent_launch_state(&terminal_id, &runtime, "starting")
        .await
        .map_err(|_| "sessione agente sostituita durante l'avvio".to_string())?;
    if let Err(error) = app
        .state::<WorkspaceRegistry>()
        .append_terminal_and_save(&workspace.id, config.clone(), 8)
        .await
    {
        let _ = manager
            .kill_generation(app, &terminal_id, runtime.generation)
            .await;
        warn!(
            terminal_id,
            workspace_id = %workspace.id,
            generation = runtime.generation,
            error_code = "agent-config-persist-failed",
            error = %error,
            "Agent terminal registration failed"
        );
        return if error.contains("limite di") {
            Err("limite di otto terminali raggiunto in questa workspace".to_string())
        } else {
            Err("non sono riuscito a registrare il nuovo terminale".to_string())
        };
    }
    let _ = app.emit(
        "jarvis-agent-opened",
        AgentOpenedEvent {
            workspace_id: workspace.id.clone(),
            terminal: config.clone(),
            generation: runtime.generation,
            process_id: runtime.process_id,
            launch_state: "starting",
        },
    );

    let command = provider_command(&definition);
    info!(
        terminal_id,
        workspace_id = %workspace.id,
        generation = runtime.generation,
        provider = %provider,
        "Agent open: writing launch command"
    );
    // A stalled PTY write (contended session lock, full pipe) must not hang
    // the whole chat request: bound it and roll back the opened terminal.
    let write_result = tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_typed_for_generation(
            app,
            &terminal_id,
            runtime.generation,
            command.as_bytes(),
            TerminalInputOrigin::Internal,
        ),
    )
    .await;
    match write_result {
        Ok(Ok(())) => {
            info!(
                terminal_id,
                workspace_id = %workspace.id,
                generation = runtime.generation,
                provider = %provider,
                "Agent open: launch command written"
            );
        }
        Ok(Err(_)) => {
            rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
            return Err("non sono riuscito ad avviare l'agente nella PTY".to_string());
        }
        Err(_elapsed) => {
            warn!(
                terminal_id,
                workspace_id = %workspace.id,
                generation = runtime.generation,
                provider = %provider,
                error_code = "agent-launch-write-timeout",
                "Agent open: launch command write timed out"
            );
            rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
            return Err(
                "non sono riuscito ad avviare l'agente nella PTY (timeout di scrittura)"
                    .to_string(),
            );
        }
    }
    if let Err(error) = wait_until_ready(app, &terminal_id, &runtime, &definition).await {
        rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
        return Err(error);
    }
    info!(
        terminal_id,
        workspace_id = %workspace.id,
        generation = runtime.generation,
        provider = %provider,
        "Agent open: readiness verified"
    );
    let mut sent = false;
    let mut dispatch_receipt = None;
    if let Some(prompt) = initial_prompt {
        let prompt = match validate_agent_text(&prompt) {
            Ok(prompt) => prompt,
            Err(_) => {
                rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
                return Err("prompt iniziale non valido".to_string());
            }
        };
        let snapshot = match app
            .state::<TerminalManager>()
            .get_agent_snapshot(&terminal_id)
            .await
        {
            Ok(Some(snapshot)) => snapshot,
            _ => {
                rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
                return Err("sessione agente non disponibile".to_string());
            }
        };
        let mut target_terminal = terminal_summary_for_config(&config, snapshot.generation);
        target_terminal.process_id = snapshot.process_id;
        target_terminal.agent_alias = snapshot.agent_alias.clone();
        let mut target_session = synthetic_session(&config, snapshot.generation);
        target_session.reference.agent_session_id = app
            .state::<crate::jarvis::JarvisState>()
            .registry
            .current_session_id(&snapshot);
        target_session.reference.agent_alias = snapshot.agent_alias.clone();
        let dispatch = match send_to_target(
            app,
            invocation,
            &ResolvedAgentTarget {
                terminal: target_terminal,
                session: target_session,
            },
            &prompt,
            None,
        )
        .await
        {
            Ok(dispatch) => dispatch,
            Err(error) => {
                rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
                return Err(error);
            }
        };
        app.state::<crate::jarvis::JarvisState>()
            .control
            .record_assignment(&invocation.target_workspace_id, dispatch.binding.clone());
        dispatch_receipt = Some(dispatch);
        sent = true;
    }
    manager
        .set_backend_agent_launch_state(&terminal_id, &runtime, "ready")
        .await
        .map_err(|_| "sessione agente sostituita durante l'avvio".to_string())?;
    let _ = app.emit(
        "jarvis-agent-opened",
        AgentOpenedEvent {
            workspace_id: workspace.id.clone(),
            terminal: config.clone(),
            generation: runtime.generation,
            process_id: runtime.process_id,
            launch_state: "ready",
        },
    );
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "opening_agent",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    checkpoint.complete();
    Ok(OpenResult::Opened {
        provider: definition.name,
        sent,
        terminal_id: terminal_id.clone(),
        generation: runtime.generation,
        agent_alias,
        agent_session_id: app
            .state::<crate::jarvis::JarvisState>()
            .registry
            .current_session_id(
                &manager
                    .get_agent_snapshot(&terminal_id)
                    .await
                    .map_err(|_| "sessione agente non disponibile".to_string())?
                    .ok_or_else(|| "sessione agente non disponibile".to_string())?,
            ),
        dispatch: dispatch_receipt,
    })
}

fn provider_command(definition: &AgentDefinition) -> String {
    if definition.args.is_empty() {
        format!("{}\r", definition.command)
    } else {
        format!("{} {}\r", definition.command, definition.args.join(" "))
    }
}

fn allocate_agent_alias(workspace: &WorkspaceConfig, provider: &str) -> String {
    let base = provider.trim().to_ascii_lowercase();
    let used = workspace
        .terminals
        .iter()
        .filter_map(|terminal| terminal.agent_alias.as_deref())
        .map(str::to_ascii_lowercase)
        .collect::<HashSet<_>>();
    if !used.contains(&base) {
        return base;
    }
    (2..=99)
        .map(|index| format!("{base}-{index}"))
        .find(|alias| !used.contains(alias))
        .unwrap_or_else(|| format!("{base}-{}", used.len() + 1))
}

fn automatic_agent_title(provider: &str, prompt: Option<&str>) -> String {
    let provider = provider.trim();
    let short = prompt
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if short.is_empty() {
        return provider.to_string();
    }
    let mut short = short;
    if short.chars().count() > 36 {
        short = short.chars().take(36).collect::<String>();
        short.push('…');
    }
    format!("{provider} — {short}")
}

async fn rollback_open_agent(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    terminal_id: &str,
    runtime: &TerminalRuntimeIdentity,
) {
    let manager = app.state::<TerminalManager>();
    // Natural process exit does not remove TerminalSession from the manager;
    // `kill_generation` can therefore still remove that exact dead lifetime.
    // If this fails, the id is absent or already belongs to a replacement and
    // deleting the id-only persisted config would risk removing the new pane.
    if let Err(error) = manager
        .kill_generation(app, terminal_id, runtime.generation)
        .await
    {
        warn!(
            terminal_id,
            workspace_id = %workspace.id,
            generation = runtime.generation,
            process_id = ?runtime.process_id,
            error_code = "rollback-runtime-mismatch",
            error = %error,
            "Agent-open rollback preserved config because the exact PTY lifetime was not removable"
        );
        return;
    }
    let registry = app.state::<WorkspaceRegistry>();
    let removed = manager
        .commit_terminal_close(
            &registry,
            terminal_id,
            &workspace.id,
            runtime.generation,
            runtime.process_id,
        )
        .await;
    match removed {
        Ok(_) => {}
        Err(error) => {
            warn!(
                terminal_id,
                workspace_id = %workspace.id,
                generation = runtime.generation,
                error_code = "rollback-close-commit-failed",
                error = %error,
                "Agent-open rollback preserved config because exact close cleanup did not commit"
            );
            return;
        }
    }
    let _ = app.emit(
        "jarvis-agent-closed",
        AgentClosedEvent {
            workspace_id: workspace.id.clone(),
            terminal_id: terminal_id.to_string(),
            generation: runtime.generation,
            process_id: runtime.process_id,
        },
    );
}

async fn wait_until_ready(
    app: &AppHandle,
    terminal_id: &str,
    expected_runtime: &TerminalRuntimeIdentity,
    definition: &AgentDefinition,
) -> Result<(), String> {
    let deadline = Instant::now() + READINESS_TIMEOUT;
    let mut last_heartbeat = Instant::now();
    loop {
        let snapshot = app
            .state::<TerminalManager>()
            .get_agent_snapshot(terminal_id)
            .await
            .map_err(|_| "sessione agente non disponibile".to_string())?
            .ok_or_else(|| "sessione agente non disponibile".to_string())?;
        validate_readiness_runtime(&snapshot, expected_runtime)?;
        if !snapshot.process_alive {
            return Err("l'agente è terminato prima di diventare pronto".to_string());
        }
        let tail = app
            .state::<TerminalManager>()
            .get_recent_normalized_terminal_text_for_runtime(
                terminal_id,
                &expected_runtime.workspace_id,
                expected_runtime.generation,
                expected_runtime.process_id,
                MAX_TAIL_BYTES,
            )
            .await
            .unwrap_or_else(|_| crate::jarvis::agent_registry::NormalizedTerminalText {
                content: String::new(),
                truncated: false,
            });
        if last_heartbeat.elapsed() >= Duration::from_secs(5) {
            last_heartbeat = Instant::now();
            warn!(
                terminal_id,
                workspace_id = %expected_runtime.workspace_id,
                generation = expected_runtime.generation,
                process_id = ?expected_runtime.process_id,
                provider = %definition.id,
                elapsed_ms = deadline.saturating_duration_since(Instant::now()).as_millis() as u64,
                tail_chars = tail.content.chars().count(),
                "Agent readiness still pending"
            );
        }
        let lower = tail.content.to_ascii_lowercase();
        if let Some(code) = startup_failure_code(&lower) {
            warn!(
                terminal_id,
                workspace_id = %expected_runtime.workspace_id,
                generation = expected_runtime.generation,
                process_id = ?expected_runtime.process_id,
                provider = %definition.id,
                error_code = code,
                "Agent readiness rejected by bounded startup error evidence"
            );
            return Err(format!(
                "il comando dell'agente non è partito correttamente ({code})"
            ));
        }
        if let Some(evidence) = readiness_evidence(&snapshot, definition, &lower) {
            info!(
                terminal_id,
                workspace_id = %expected_runtime.workspace_id,
                generation = expected_runtime.generation,
                process_id = ?expected_runtime.process_id,
                provider = %definition.id,
                readiness_evidence = evidence.as_str(),
                "Agent readiness verified"
            );
            return Ok(());
        }
        if Instant::now() >= deadline {
            warn!(
                terminal_id,
                workspace_id = %expected_runtime.workspace_id,
                generation = expected_runtime.generation,
                process_id = ?expected_runtime.process_id,
                provider = %definition.id,
                error_code = "readiness-timeout",
                "Agent readiness evidence timed out"
            );
            return Err("non ho potuto dimostrare che la TUI dell'agente è pronta".to_string());
        }
        tokio::time::sleep(READINESS_POLL).await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadinessEvidence {
    ProcessTree,
    TerminalHint,
}

impl ReadinessEvidence {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProcessTree => "process-tree",
            Self::TerminalHint => "terminal-hint",
        }
    }
}

fn validate_readiness_runtime(
    snapshot: &TerminalAgentSnapshot,
    expected: &TerminalRuntimeIdentity,
) -> Result<(), String> {
    if snapshot.workspace_id != expected.workspace_id
        || snapshot.generation != expected.generation
        || snapshot.process_id != expected.process_id
    {
        return Err("sessione agente sostituita durante l'avvio".to_string());
    }
    Ok(())
}

fn readiness_evidence(
    snapshot: &TerminalAgentSnapshot,
    definition: &AgentDefinition,
    normalized_tail: &str,
) -> Option<ReadinessEvidence> {
    let process_tree_matches = snapshot.detection_source == "process-tree"
        && snapshot.detection_confidence >= 0.9
        && snapshot
            .observed_provider
            .as_deref()
            .and_then(normalize_plan_provider)
            .as_deref()
            == Some(definition.id.as_str());
    if process_tree_matches {
        return Some(ReadinessEvidence::ProcessTree);
    }
    definition
        .readiness_hints
        .iter()
        .filter(|hint| !hint.trim().is_empty())
        .any(|hint| normalized_tail.contains(&hint.to_ascii_lowercase()))
        .then_some(ReadinessEvidence::TerminalHint)
}

fn startup_failure_code(normalized_tail: &str) -> Option<&'static str> {
    [
        ("commandnotfoundexception", "command-not-found"),
        (
            "is not recognized as an internal or external command",
            "command-not-found",
        ),
        (
            "not recognized as the name of a cmdlet",
            "command-not-found",
        ),
        ("command not found", "command-not-found"),
        ("cannot find module", "runtime-module-missing"),
        ("module_not_found", "runtime-module-missing"),
    ]
    .into_iter()
    .find_map(|(needle, code)| normalized_tail.contains(needle).then_some(code))
}

async fn close_target(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    target: &ResolvedAgentTarget,
) -> Result<(), String> {
    let snapshot = fresh_snapshot(app, invocation, target).await?;
    let workspace = live_workspace(app, workspace, invocation).await?;
    let manager = app.state::<TerminalManager>();
    manager
        .kill_generation(app, &target.terminal.terminal_id, snapshot.generation)
        .await
        .map_err(|_| "non sono riuscito a chiudere il terminale".to_string())?;
    let registry = app.state::<WorkspaceRegistry>();
    if let Err(error) = manager
        .commit_terminal_close(
            &registry,
            &target.terminal.terminal_id,
            &workspace.id,
            snapshot.generation,
            snapshot.process_id,
        )
        .await
    {
        warn!(
            terminal_id = %target.terminal.terminal_id,
            workspace_id = %workspace.id,
            generation = snapshot.generation,
            process_id = ?snapshot.process_id,
            error_code = "agent-close-commit-failed",
            error = %error,
            "Agent close preserved config because the exact close did not commit"
        );
        return Err("non sono riuscito ad aggiornare la workspace".to_string());
    }
    let _ = app.emit(
        "jarvis-agent-closed",
        AgentClosedEvent {
            workspace_id: workspace.id.clone(),
            terminal_id: target.terminal.terminal_id.clone(),
            generation: snapshot.generation,
            process_id: snapshot.process_id,
        },
    );
    Ok(())
}

async fn restart_target(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    target: &ResolvedAgentTarget,
) -> Result<(), String> {
    let snapshot = fresh_snapshot(app, invocation, target).await?;
    let workspace = live_workspace(app, workspace, invocation).await?;
    let config = workspace
        .terminals
        .iter()
        .find(|item| item.id == target.terminal.terminal_id)
        .cloned()
        .ok_or_else(|| "configurazione terminale non trovata".to_string())?;
    let provider = config
        .agent_id
        .as_deref()
        .and_then(normalize_plan_provider)
        .ok_or_else(|| "provider della sessione non riconosciuto".to_string())?;
    let definition = app
        .state::<crate::agent::registry::AgentRegistry>()
        .get_agent(&provider)
        .cloned()
        .ok_or_else(|| "provider della sessione non supportato".to_string())?;
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "restarting_agent",
        &format!("Restarting {}…", definition.name),
        JarvisActivityStatus::Running,
        Some(
            app.state::<crate::jarvis::JarvisState>()
                .registry
                .current_session_id(&snapshot),
        ),
    );
    let mut checkpoint = CheckpointGuard::new(app, invocation, "restarting_agent");
    app.state::<TerminalManager>()
        .kill_generation(app, &target.terminal.terminal_id, snapshot.generation)
        .await
        .map_err(|_| "non sono riuscito a fermare la sessione".to_string())?;
    app.state::<TerminalManager>()
        .spawn(app.clone(), config.clone(), 100, 30)
        .await
        .map_err(|_| "non sono riuscito a riavviare la sessione".to_string())?;
    let runtime = app
        .state::<TerminalManager>()
        .runtime_identity(&target.terminal.terminal_id)
        .await
        .map_err(|_| "sessione riavviata non disponibile".to_string())?;
    if runtime.workspace_id.as_str() != workspace.id.as_str() {
        let _ = app
            .state::<TerminalManager>()
            .kill_generation(app, &target.terminal.terminal_id, runtime.generation)
            .await;
        return Err("sessione riavviata associata alla workspace sbagliata".to_string());
    }
    app.state::<TerminalManager>()
        .set_backend_agent_launch_state(&target.terminal.terminal_id, &runtime, "starting")
        .await
        .map_err(|_| "sessione riavviata sostituita durante l'avvio".to_string())?;
    let _ = app.emit(
        "jarvis-agent-opened",
        AgentOpenedEvent {
            workspace_id: workspace.id.clone(),
            terminal: config.clone(),
            generation: runtime.generation,
            process_id: runtime.process_id,
            launch_state: "starting",
        },
    );
    let command = provider_command(&definition);
    if app
        .state::<TerminalManager>()
        .write_typed_for_generation(
            app,
            &target.terminal.terminal_id,
            runtime.generation,
            command.as_bytes(),
            TerminalInputOrigin::Internal,
        )
        .await
        .is_err()
    {
        let _ = app
            .state::<TerminalManager>()
            .set_backend_agent_launch_state(&target.terminal.terminal_id, &runtime, "failed")
            .await;
        let _ = app.emit(
            "jarvis-agent-opened",
            AgentOpenedEvent {
                workspace_id: workspace.id.clone(),
                terminal: config,
                generation: runtime.generation,
                process_id: runtime.process_id,
                launch_state: "failed",
            },
        );
        return Err("non sono riuscito a rilanciare l'agente".to_string());
    }
    if let Err(error) =
        wait_until_ready(app, &target.terminal.terminal_id, &runtime, &definition).await
    {
        let _ = app
            .state::<TerminalManager>()
            .set_backend_agent_launch_state(&target.terminal.terminal_id, &runtime, "failed")
            .await;
        let _ = app.emit(
            "jarvis-agent-opened",
            AgentOpenedEvent {
                workspace_id: workspace.id.clone(),
                terminal: config,
                generation: runtime.generation,
                process_id: runtime.process_id,
                launch_state: "failed",
            },
        );
        return Err(error);
    }

    app.state::<TerminalManager>()
        .set_backend_agent_launch_state(&target.terminal.terminal_id, &runtime, "ready")
        .await
        .map_err(|_| "sessione riavviata sostituita durante l'avvio".to_string())?;

    // Re-announce the same visible pane so the frontend clears any stale exit
    // state and marks the provider as already launched by the backend.
    let _ = app.emit(
        "jarvis-agent-opened",
        AgentOpenedEvent {
            workspace_id: workspace.id.clone(),
            terminal: config,
            generation: runtime.generation,
            process_id: runtime.process_id,
            launch_state: "ready",
        },
    );
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "restarting_agent",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    checkpoint.complete();
    Ok(())
}

fn terminal_summary_for_config(config: &TerminalConfig, generation: u64) -> TerminalSummary {
    TerminalSummary {
        terminal_id: config.id.clone(),
        workspace_id: config.workspace_id.clone().unwrap_or_default(),
        title: config.title.clone(),
        agent_alias: config.agent_alias.clone(),
        shell: config.shell.clone(),
        cwd: config.cwd.clone(),
        active: false,
        process_id: None,
        process_alive: true,
        agent_id: config.agent_id.clone(),
        configured_agent_id: config.agent_id.clone(),
        observed_provider: config.agent_id.clone(),
        resolved_provider: config
            .agent_id
            .clone()
            .unwrap_or_else(|| "terminal-agent".to_string()),
        detection_source: "configured-hint".to_string(),
        detection_confidence: 0.65,
        identity_warnings: Vec::new(),
        generation,
        provenance: Provenance::trusted("agent-open", &now()),
    }
}

fn synthetic_session(config: &TerminalConfig, generation: u64) -> AgentSessionContext {
    let provider = config
        .agent_id
        .clone()
        .unwrap_or_else(|| "terminal-agent".to_string());
    AgentSessionContext {
        reference: crate::jarvis::types::AgentSessionRef {
            agent_session_id: format!("{}:{generation}", config.id),
            provider: provider.clone(),
            configured_agent_id: config.agent_id.clone(),
            observed_provider: config.agent_id.clone(),
            resolved_provider: provider.clone(),
            detection_source: "configured-hint".to_string(),
            detection_confidence: 0.65,
            identity_warnings: Vec::new(),
            identity_needs_confirmation: false,
            workspace_id: config.workspace_id.clone().unwrap_or_default(),
            terminal_id: Some(config.id.clone()),
            agent_alias: config.agent_alias.clone(),
            terminal_title: Some(config.title.clone()),
            generation,
            provider_session_id: None,
            provider_turn_id: None,
            created_at: now(),
            updated_at: now(),
            current_task: None,
            last_activity_at: None,
        },
        configured_agent_id: config.agent_id.clone(),
        observed_provider: config.agent_id.clone(),
        resolved_provider: provider,
        detection_source: "configured-hint".to_string(),
        detection_confidence: 0.65,
        identity_warnings: Vec::new(),
        identity_needs_confirmation: false,
        objective: None,
        state: AgentState::Waiting,
        last_turn: None,
        last_result: None,
        completion_notification: None,
        messages: None,
        provenance: Provenance::trusted("agent-open", &now()),
        confidence: 0.65,
        warnings: Vec::new(),
        current_task: None,
        last_activity_at: None,
    }
}

fn build_agent_report(context: &crate::jarvis::types::ModelContextViewV1) -> String {
    let current = context
        .agent_sessions
        .iter()
        .filter_map(|session| {
            let terminal_id = session.reference.terminal_id.as_deref()?;
            let terminal = context.terminals.iter().find(|terminal| {
                terminal.terminal_id == terminal_id
                    && terminal.generation == session.reference.generation
                    && terminal.workspace_id == context.invocation.target_workspace_id
            })?;
            Some((session, terminal))
        })
        .take(8)
        .collect::<Vec<_>>();

    if current.is_empty() {
        return "Non ci sono agenti aperti in questa workspace.".to_string();
    }

    let mut parts = Vec::new();
    for (session, terminal) in &current {
        let title = if !terminal.title.trim().is_empty()
            && !terminal.title.eq_ignore_ascii_case("terminal")
        {
            terminal.title.clone()
        } else {
            provider_display_name(&session.resolved_provider)
        };
        let task = session.current_task.as_ref();
        let detail = match session.state {
            AgentState::Working | AgentState::Starting => task
                .filter(|task| task.completed_at.is_none())
                .map(|task| format!("sta lavorando su {}", preview_text(&task.text)))
                .unwrap_or_else(|| "sta lavorando".to_string()),
            AgentState::Waiting => task
                .filter(|task| task.completed_at.is_some())
                .map(|task| format!("ha finito {}", preview_text(&task.text)))
                .unwrap_or_else(|| "è in attesa".to_string()),
            AgentState::Completed => task
                .map(|task| format!("ha finito {}", preview_text(&task.text)))
                .unwrap_or_else(|| "ha finito".to_string()),
            AgentState::Failed => "è in errore".to_string(),
            AgentState::Aborted => "è stato interrotto".to_string(),
            AgentState::Exited => "è chiuso".to_string(),
            AgentState::Unknown => "ha stato sconosciuto".to_string(),
        };
        parts.push(format!("{title} {detail}"));
    }
    format!("Hai {} agenti. {}.", current.len(), parts.join(", "))
}

fn provider_display_name(provider: &str) -> String {
    let mut chars = provider.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "agente".to_string(),
    }
}

fn preview_text(value: &str) -> String {
    let value = value.replace(['\r', '\n'], " ");
    let (value, _) = truncate_from_end(&value, 100);
    value
}

fn compact_response(value: &str) -> String {
    let value = value.trim();
    let (value, _) = truncate_from_end(value, 1200);
    value
}

fn truncate_from_end(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    (value[start..].to_string(), true)
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_provider_alias_maps_p_to_pi() {
        assert_eq!(normalize_plan_provider("p"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("P"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("pi"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("codex"), Some("codex".to_string()));
        assert_eq!(
            normalize_plan_provider("opencode"),
            Some("opencode".to_string())
        );
        assert_eq!(
            normalize_plan_provider(" agente P "),
            Some("pi".to_string())
        );
        assert_eq!(normalize_plan_provider("openai"), None);
    }

    #[test]
    fn plan_validation_accepts_p_alias_provider() {
        let plan = ConversationalPlan {
            response: None,
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentOpen,
                provider: Some("p".to_string()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("fai una task".to_string()),
                confirmed: false,
                allow_busy: false,
            }],
        };
        assert!(plan.validate().is_ok());
    }

    #[test]
    fn multi_agent_dispatch_rejects_a_step_without_an_explicit_target() {
        let operations = vec![
            ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("pi".into()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("controlla il frontend".into()),
                confirmed: false,
                allow_busy: false,
            },
            ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: None,
                target: None,
                source: None,
                destination: None,
                prompt: Some("controlla i test".into()),
                confirmed: false,
                allow_busy: false,
            },
        ];
        assert!(validate_agent_dispatches(&operations).is_err());
    }

    #[test]
    fn independent_agent_sends_are_the_only_plan_shape_parallelized() {
        let send = |provider: &str| ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some(provider.into()),
            target: None,
            source: None,
            destination: None,
            prompt: Some(format!("task for {provider}")),
            confirmed: false,
            allow_busy: false,
        };
        assert!(should_parallelize_agent_sends(&[send("codex"), send("pi")]));
        let mut dependent = send("pi");
        dependent.operation = PlanOperation::AgentHandoff;
        assert!(!should_parallelize_agent_sends(&[send("codex"), dependent]));
    }

    #[test]
    fn resuming_pending_work_keeps_the_unexecuted_tail() {
        let pending_first = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some("pi".into()),
            target: Some("PI".into()),
            source: None,
            destination: None,
            prompt: Some("review frontend".into()),
            confirmed: false,
            allow_busy: false,
        };
        let pending_tail = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some("codex".into()),
            target: Some("Codex".into()),
            source: None,
            destination: None,
            prompt: Some("review backend".into()),
            confirmed: false,
            allow_busy: false,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "w".into(),
            kind: PendingConversationKind::Clarification,
            question: "aggiungo il task?".into(),
            operation: PlanOperation::AgentSend,
            terminal_id: Some("pi-terminal".into()),
            generation: Some(1),
            binding: None,
            created_at: "2026-08-07T00:00:00Z".into(),
            expires_at: "2999-08-07T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![pending_first, pending_tail.clone()],
                response: None,
            },
        };
        let answer = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: true,
        };
        let (operations, resumes) = operations_for_execution(
            &ConversationalPlan {
                operations: vec![answer],
                response: None,
            },
            Some(&pending),
        );
        assert!(resumes);
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[1], pending_tail);
    }

    fn readiness_definition() -> AgentDefinition {
        AgentDefinition {
            id: "codex".into(),
            name: "Codex".into(),
            description: String::new(),
            command: "codex".into(),
            args: Vec::new(),
            env: HashMap::new(),
            icon: String::new(),
            color: String::new(),
            readiness_hints: vec!["shortcuts".into(), "openai".into()],
        }
    }

    fn readiness_snapshot(source: &str, provider: Option<&str>) -> TerminalAgentSnapshot {
        TerminalAgentSnapshot {
            terminal_id: "terminal-a".into(),
            workspace_id: "workspace-a".into(),
            is_agent_terminal: true,
            agent_id: Some("codex".into()),
            agent_alias: Some("codex-1".into()),
            observed_provider: provider.map(str::to_string),
            detection_source: source.into(),
            detection_confidence: if source == "process-tree" { 0.95 } else { 0.7 },
            identity_warnings: Vec::new(),
            generation: 7,
            process_id: Some(42),
            process_alive: true,
        }
    }

    fn sample_terminal(generation: u64) -> TerminalSummary {
        TerminalSummary {
            terminal_id: "t".into(),
            workspace_id: "w".into(),
            title: "Codex Auth".into(),
            agent_alias: Some("codex-1".into()),
            shell: "shell".into(),
            cwd: ".".into(),
            active: false,
            process_id: Some(42),
            process_alive: true,
            agent_id: Some("codex".into()),
            configured_agent_id: Some("codex".into()),
            observed_provider: Some("codex".into()),
            resolved_provider: "codex".into(),
            detection_source: "test".into(),
            detection_confidence: 1.0,
            identity_warnings: Vec::new(),
            generation,
            provenance: Provenance::trusted("test", "now"),
        }
    }

    #[test]
    fn readiness_accepts_process_identity_without_tui_wording() {
        let definition = readiness_definition();
        let snapshot = readiness_snapshot("process-tree", Some("codex"));
        assert_eq!(
            readiness_evidence(&snapshot, &definition, "completely new tui"),
            Some(ReadinessEvidence::ProcessTree),
        );

        let wrong_provider = readiness_snapshot("process-tree", Some("claude"));
        assert_eq!(
            readiness_evidence(&wrong_provider, &definition, "completely new tui"),
            None,
        );
    }

    #[test]
    fn readiness_hints_remain_a_bounded_fallback_and_startup_errors_are_explicit() {
        let definition = readiness_definition();
        let snapshot = readiness_snapshot("command-observed", Some("codex"));
        assert_eq!(
            readiness_evidence(&snapshot, &definition, "type /shortcuts for help"),
            Some(ReadinessEvidence::TerminalHint),
        );
        assert_eq!(
            startup_failure_code("categoryinfo: commandnotfoundexception"),
            Some("command-not-found"),
        );
        assert_eq!(
            startup_failure_code("error: cannot find module cli.js"),
            Some("runtime-module-missing"),
        );
    }

    #[test]
    fn readiness_validates_the_complete_runtime_identity() {
        let snapshot = readiness_snapshot("process-tree", Some("codex"));
        let runtime = TerminalRuntimeIdentity {
            workspace_id: "workspace-a".into(),
            generation: 7,
            process_id: Some(42),
            agent_launch_owner: Some("backend".into()),
            agent_launch_state: Some("starting".into()),
        };
        assert!(validate_readiness_runtime(&snapshot, &runtime).is_ok());

        let mut stale = runtime;
        stale.process_id = Some(43);
        assert_eq!(
            validate_readiness_runtime(&snapshot, &stale).unwrap_err(),
            "sessione agente sostituita durante l'avvio",
        );
    }

    #[test]
    fn plan_rejects_unknown_provider_and_arbitrary_control_bytes() {
        let invalid = ConversationalPlan {
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("unknown".into()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("x".into()),
                confirmed: false,
                allow_busy: false,
            }],
            response: None,
        };
        assert!(invalid.validate().is_err());
        assert!(validate_plan_text("\0").is_err());
    }

    #[test]
    fn continuation_send_may_defer_prompt_validation_until_pending_merge() {
        let continuation = ConversationalPlan {
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("codex".into()),
                target: None,
                source: None,
                destination: None,
                prompt: None,
                confirmed: false,
                allow_busy: true,
            }],
            response: None,
        };
        assert!(continuation.validate().is_ok());
    }

    #[test]
    fn handoff_to_new_agent_preserves_source_and_instruction() {
        let previous = ConversationStep {
            operation: PlanOperation::AgentHandoff,
            provider: Some("opencode".into()),
            target: None,
            source: Some("Codex Auth".into()),
            destination: Some("OpenCode Review".into()),
            prompt: Some("controlla soprattutto i test".into()),
            confirmed: false,
            allow_busy: false,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "w".into(),
            kind: PendingConversationKind::Clarification,
            question: "aprirne uno nuovo?".into(),
            operation: PlanOperation::AgentHandoff,
            terminal_id: Some("busy".into()),
            generation: Some(1),
            binding: None,
            created_at: "2026-08-07T00:00:00Z".into(),
            expires_at: "2999-08-07T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![previous],
                response: None,
            },
        };
        let next = ConversationStep {
            operation: PlanOperation::AgentOpen,
            provider: Some("pi".into()),
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: false,
        };
        let merged = merge_step_with_pending(&next, Some(&pending));
        assert_eq!(merged.source.as_deref(), Some("Codex Auth"));
        assert_eq!(
            merged.prompt.as_deref(),
            Some("controlla soprattutto i test")
        );
        assert_eq!(merged.provider.as_deref(), Some("pi"));
    }

    #[test]
    fn tail_is_bounded_by_lines_and_bytes_and_untrusted() {
        let tail = build_tail("w", "t", 4, "a\nb\nc\nd", 2, false);
        assert_eq!(tail.content, "c\nd");
        assert!(tail.truncated);
        assert!(tail.provenance.untrusted);
    }

    #[test]
    fn candidate_resolution_score_uses_read_only_title_and_prefers_waiting() {
        let terminal = sample_terminal(1);
        let mut working = synthetic_session(
            &TerminalConfig {
                id: "t".into(),
                shell: "shell".into(),
                agent_id: Some("codex".into()),
                command: None,
                cwd: ".".into(),
                title: "Codex Auth".into(),
                agent_alias: None,
                title_manual: true,
                workspace_id: Some("w".into()),
            },
            1,
        );
        working.state = AgentState::Working;
        let mut waiting = working.clone();
        waiting.state = AgentState::Waiting;
        assert!(score_candidate("auth", &working, &terminal, None) > 0);
        assert!(
            score_candidate("auth", &waiting, &terminal, None)
                > score_candidate("auth", &working, &terminal, None)
        );
    }

    fn routing_fixture_context(generation: u64) -> crate::jarvis::types::ModelContextViewV1 {
        use crate::jarvis::types::{DocumentationSummary, RequestedDepth};
        let mut terminals = Vec::new();
        let mut agent_sessions = Vec::new();
        for (index, alias) in ["codex-1", "codex-2", "codex-3"].into_iter().enumerate() {
            let id = format!("terminal-{}", index + 1);
            let config = TerminalConfig {
                id: id.clone(),
                shell: "powershell.exe".into(),
                agent_id: Some("codex".into()),
                command: None,
                cwd: "C:\\repo".into(),
                title: "Codex — Traflix-Space".into(),
                agent_alias: Some(alias.into()),
                title_manual: false,
                workspace_id: Some("workspace-a".into()),
            };
            let mut terminal = terminal_summary_for_config(&config, generation);
            terminal.process_id = Some(100 + index as u32);
            let mut session = synthetic_session(&config, generation);
            session.reference.agent_session_id = format!("session-{alias}");
            session.reference.agent_alias = Some(alias.into());
            session.reference.terminal_id = Some(id);
            terminals.push(terminal);
            agent_sessions.push(session);
        }
        crate::jarvis::types::ModelContextViewV1 {
            view_version: "test".into(),
            invocation: InvocationBinding::new(
                "request-test",
                "workspace-a",
                None,
                None,
                "2026-08-12T00:00:00Z",
            ),
            documentation_summary: DocumentationSummary {
                workspace_id: "workspace-a".into(),
                revision: "test".into(),
                cache_status: crate::jarvis::types::CacheStatus::Hit,
                document_count: 0,
                omitted_count: 0,
                truncated_count: 0,
                warning_count: 0,
            },
            document_index: Vec::new(),
            documentation_excerpts: Vec::new(),
            terminals,
            agent_sessions,
            requested_depth: RequestedDepth::Summary,
            provenance: Provenance::trusted("test", "now"),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn equal_display_titles_select_only_the_stable_alias_binding() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:2".into(),
            agent_alias: "codex-2".into(),
            agent_session_id: "session-codex-2".into(),
            terminal_id: "terminal-2".into(),
            generation: 7,
            process_id: Some(101),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let target = target_from_binding(&context, &binding).expect("exact alias binding");
        assert_eq!(target.terminal.title, "Codex — Traflix-Space");
        assert_eq!(target.terminal.terminal_id, "terminal-2");
        assert_eq!(
            target.session.reference.agent_alias.as_deref(),
            Some("codex-2")
        );
    }

    #[test]
    fn generation_change_rejects_follow_up_without_fallback() {
        let context = routing_fixture_context(8);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: None,
        };
        assert_eq!(
            target_from_binding(&context, &binding).unwrap_err(),
            "agent_binding_stale_or_mismatch"
        );
    }

    #[test]
    fn follow_up_uses_the_pending_binding_with_duplicate_titles() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:2".into(),
            agent_alias: "codex-2".into(),
            agent_session_id: "session-codex-2".into(),
            terminal_id: "terminal-2".into(),
            generation: 7,
            process_id: Some(101),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "workspace-a".into(),
            kind: PendingConversationKind::Clarification,
            question: "continua?".into(),
            operation: PlanOperation::AgentSend,
            terminal_id: Some("terminal-2".into()),
            generation: Some(7),
            binding: Some(binding),
            created_at: "2026-08-12T00:00:00Z".into(),
            expires_at: "2999-08-12T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![ConversationStep {
                    operation: PlanOperation::AgentSend,
                    provider: None,
                    target: None,
                    source: None,
                    destination: None,
                    prompt: Some("continua il lavoro".into()),
                    confirmed: false,
                    allow_busy: true,
                }],
                response: None,
            },
        };
        let incoming = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: true,
        };
        let merged = merge_step_with_pending(&incoming, Some(&pending));
        let target = bound_target_from_pending(&context, Some(&pending), &merged, &incoming)
            .expect("pending binding is valid")
            .expect("follow-up must use the pending binding");
        assert_eq!(target.terminal.terminal_id, "terminal-2");
        assert_eq!(
            target.session.reference.agent_alias.as_deref(),
            Some("codex-2")
        );
    }

    #[test]
    fn provider_session_change_rejects_binding_without_title_fallback() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: Some("provider-session-before-restart".into()),
        };
        assert_eq!(
            target_from_binding(&context, &binding).unwrap_err(),
            "agent_binding_stale_or_mismatch"
        );
    }

    #[test]
    fn successful_pty_write_without_observable_turn_is_unconfirmed() {
        assert_eq!(DISPATCH_TURN_STARTED, "turn_started");
        assert_eq!(
            unconfirmed_dispatch_stages(),
            vec![
                "pty_write_accepted",
                "prompt_submitted",
                "submission_unconfirmed"
            ]
        );
        assert_ne!(DISPATCH_SUBMISSION_UNCONFIRMED, DISPATCH_TURN_STARTED);
    }

    #[test]
    fn dispatch_lock_is_shared_per_alias_and_receipt_is_complete() {
        let registry = crate::jarvis::agent_registry::AgentSessionRegistry::default();
        let first = registry.dispatch_lock("codex-1");
        let second = registry.dispatch_lock("codex-1");
        assert!(std::sync::Arc::ptr_eq(&first, &second));

        let receipt = StepExecutionReceipt {
            operation: PlanOperation::AgentSend,
            status: DISPATCH_SUBMISSION_UNCONFIRMED,
            target: Some("codex-1 — Codex — Traflix-Space".into()),
            message: "Scritto; avvio non confermato.".into(),
            recipient: Some(AgentRecipientReceipt {
                assignment_id: "assignment:test:1".into(),
                agent_alias: "codex-1".into(),
                agent_session_id: "session-codex-1".into(),
                terminal_id: "terminal-1".into(),
                generation: 7,
                process_id: Some(100),
                provider: "codex".into(),
                provider_session_id: Some("provider-session-1".into()),
                display_title: "Codex — Traflix-Space".into(),
            }),
            stages: unconfirmed_dispatch_stages(),
        };
        let json = serde_json::to_value(receipt).expect("receipt serializable");
        assert_eq!(json["recipient"]["agentAlias"], "codex-1");
        assert_eq!(json["recipient"]["agentSessionId"], "session-codex-1");
        assert_eq!(json["recipient"]["terminalId"], "terminal-1");
        assert_eq!(json["recipient"]["generation"], 7);
        assert_eq!(json["recipient"]["providerSessionId"], "provider-session-1");
        assert_eq!(json["status"], "submission_unconfirmed");
    }

    #[tokio::test]
    async fn simultaneous_sends_for_one_alias_wait_on_one_lock() {
        let registry = crate::jarvis::agent_registry::AgentSessionRegistry::default();
        let first = registry.dispatch_lock("codex-1");
        let second = registry.dispatch_lock("codex-1");
        let guard = first.lock().await;
        let waiter = tokio::spawn(async move {
            let _guard = second.lock().await;
            true
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(guard);
        assert!(waiter.await.expect("lock waiter completed"));
    }

    #[test]
    fn automatic_title_is_short_and_aliases_are_not_title_based() {
        assert!(
            automatic_agent_title("Codex", Some("fix the voice normalization regression"))
                .chars()
                .count()
                <= 46
        );
        let workspace = WorkspaceConfig {
            id: "workspace-a".into(),
            name: "Workspace".into(),
            root_path: "C:\\repo".into(),
            layout: crate::workspace::registry::GridLayout { rows: 1, cols: 1 },
            terminals: vec![
                TerminalConfig {
                    id: "one".into(),
                    shell: "powershell.exe".into(),
                    agent_id: Some("codex".into()),
                    command: None,
                    cwd: "C:\\repo".into(),
                    title: "Codex".into(),
                    agent_alias: Some("codex".into()),
                    title_manual: false,
                    workspace_id: Some("workspace-a".into()),
                },
                TerminalConfig {
                    id: "two".into(),
                    shell: "powershell.exe".into(),
                    agent_id: Some("codex".into()),
                    command: None,
                    cwd: "C:\\repo".into(),
                    title: "Codex".into(),
                    agent_alias: Some("codex-2".into()),
                    title_manual: false,
                    workspace_id: Some("workspace-a".into()),
                },
            ],
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        assert_eq!(allocate_agent_alias(&workspace, "codex"), "codex-3");
    }
}
