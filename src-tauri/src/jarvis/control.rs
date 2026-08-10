//! Conversational control is the seam between the model's semantic plan and
//! Traflix's real, visible PTYs. The model can propose only the typed values
//! in this module; this module owns target resolution, workspace validation,
//! bounded context, readiness and side effects.

use crate::agent::registry::AgentDefinition;
use crate::jarvis::actions::{prompt_bytes, validate_agent_text};
use crate::jarvis::agent_registry::session_id_for;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::runtime_detector::normalize_provider;

/// Provider alias resolution for plan execution. The pi agent is commonly
/// named by its single letter ('p', 'agente P') in speech transcripts, which
/// STT may deliver without the trailing 'i'; map it to the canonical 'pi'
/// provider instead of rejecting or misreading it as another agent.
fn normalize_plan_provider(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "p" => Some("pi".to_string()),
        other => normalize_provider(other),
    }
}
use crate::jarvis::types::{
    AgentSessionContext, AgentState, AgentTail, InvocationBinding, Provenance, TerminalSummary,
};
use crate::terminal_engine::{
    TerminalAgentSnapshot, TerminalInputOrigin, TerminalManager, TerminalRuntimeIdentity,
};
use crate::workspace::registry::{TerminalConfig, WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub created_at: String,
    pub expires_at: String,
    pub plan: ConversationalPlan,
}

#[derive(Default)]
pub struct ConversationalControlState {
    pending: Mutex<HashMap<String, PendingConversationalIntent>>,
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
    } = opened;
    Ok(AgentOpenResult {
        provider,
        terminal_id,
        generation,
        initial_prompt_sent: sent,
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
        };
    }

    let state = app.state::<crate::jarvis::JarvisState>();
    let pending = state.control.pending(&invocation.target_workspace_id);
    state.control.clear(&invocation.target_workspace_id);
    let mut response = plan.response.clone().unwrap_or_default();
    let warnings = Vec::new();

    for step in plan.operations {
        if cancellation.is_cancelled() {
            return ControlExecution {
                response: "La richiesta è stata annullata.".to_string(),
                warnings,
            };
        }
        info!(
            request_id = %invocation.request_id,
            workspace_id = %invocation.target_workspace_id,
            operation = ?step.operation,
            provider = step.provider.as_deref().unwrap_or(""),
            "Jarvis plan step executing"
        );
        let result =
            execute_step(app, workspace, invocation, context, pending.as_ref(), &step).await;
        match result {
            Ok(step_response) => {
                if !step_response.is_empty() {
                    response = if response.trim().is_empty() {
                        step_response
                    } else {
                        // Multi-operation plans (e.g. two agent opens) must
                        // mention every executed action, not just the last
                        // step's reply.
                        format!("{response} {step_response}")
                    };
                }
                // A clarification/confirmation is a hard conversational
                // boundary. Never continue later plan operations after asking
                // the user for a choice, even if the model emitted more steps.
                if state
                    .control
                    .pending(&invocation.target_workspace_id)
                    .is_some()
                {
                    break;
                }
            }
            Err(step_error) => {
                return ControlExecution {
                    response: step_error,
                    warnings,
                };
            }
        }
    }

    if response.trim().is_empty() {
        response = "Fatto.".to_string();
    }
    response = compact_response(&response);
    ControlExecution { response, warnings }
}

async fn execute_step(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    incoming_step: &ConversationStep,
) -> Result<String, String> {
    // The current turn carries the new choice (provider, confirmed,
    // allowBusy), while the exact pending state preserves omitted semantic
    // fields from the previous turn. This lets short answers such as “sì”,
    // “usa quello” or “Codex” safely continue the dialogue.
    let step = merge_step_with_pending(incoming_step, pending);
    let step = &step;

    match step.operation {
        PlanOperation::Respond => Ok(step
            .prompt
            .clone()
            .or_else(|| Some("Dimmi pure.".to_string()))
            .unwrap_or_default()),
        PlanOperation::Clarify => {
            let question = step
                .prompt
                .clone()
                .or_else(|| Some("Mi serve un dettaglio in più.".to_string()))
                .unwrap_or_default();
            put_clarification(app, invocation, step, question.clone());
            Ok(question)
        }
        PlanOperation::DraftPrompt => Ok(step.prompt.clone().unwrap_or_default()),
        PlanOperation::AgentReport => Ok(build_agent_report(context)),
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
                return Ok(question);
            };
            let opened = open_agent(app, workspace, invocation, &provider, initial_prompt).await?;
            Ok(match opened {
                OpenResult::Opened { provider, sent, .. } => {
                    if sent {
                        format!("Fatto, ho aperto {provider} e gli ho passato la task.")
                    } else {
                        format!("Fatto, ho aperto {provider}.")
                    }
                }
            })
        }
        PlanOperation::AgentSend => {
            let target = if let Some(target) = bound_target_from_pending(context, pending, step) {
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
            let target = target_or_clarify(app, invocation, step, target, "inviare la task")?;
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
                return Ok(question);
            }
            let prompt = validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                .map_err(|_| "Non ho inviato il task: il prompt non è valido.".to_string())?;
            send_to_target(app, invocation, &target, &prompt).await?;
            Ok(format!("Fatto, l'ho inviato a {}.", target_label(&target)))
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
            let destination =
                if let Some(target) = bound_target_from_pending(context, pending, step) {
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
                return Ok(question);
            }
            let evidence = source_evidence(app, &source).await?;
            let prompt = build_handoff_prompt(
                &source,
                &evidence,
                step.prompt.as_deref().unwrap_or_default(),
            )?;
            send_to_target(app, invocation, &destination, &prompt).await?;
            Ok(format!(
                "Fatto, ho passato a {} il risultato di {}.",
                target_label(&destination),
                target_label(&source)
            ))
        }
        PlanOperation::AgentAbort => {
            let resolution = if let Some(target) = bound_target_from_pending(context, pending, step)
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
                return Ok(question);
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
            Ok(format!("Fatto, ho interrotto {}.", target_label(&target)))
        }
        PlanOperation::TerminalClose => {
            let resolution = if let Some(target) = bound_target_from_pending(context, pending, step)
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
                return Ok(question);
            }
            close_target(app, workspace, invocation, &target).await?;
            Ok(format!("Fatto, ho chiuso {}.", target_label(&target)))
        }
        PlanOperation::TerminalRestart => {
            let resolution = if let Some(target) = bound_target_from_pending(context, pending, step)
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
                return Ok(question);
            }
            restart_target(app, workspace, invocation, &target).await?;
            Ok(format!("Fatto, ho riavviato {}.", target_label(&target)))
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

fn bound_target_from_pending(
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
) -> Option<ResolvedAgentTarget> {
    if !step.confirmed && !step.allow_busy {
        return None;
    }
    let pending = pending?;
    if pending.operation != step.operation {
        return None;
    }
    let terminal_id = pending.terminal_id.as_deref()?;
    let generation = pending.generation?;
    let terminal = context.terminals.iter().find(|terminal| {
        terminal.terminal_id == terminal_id
            && terminal.generation == generation
            && terminal.workspace_id == context.invocation.target_workspace_id
    })?;
    let session = context.agent_sessions.iter().find(|session| {
        session.reference.terminal_id.as_deref() == Some(terminal_id)
            && session.reference.generation == generation
            && session.reference.workspace_id == context.invocation.target_workspace_id
    })?;
    Some(ResolvedAgentTarget {
        terminal: terminal.clone(),
        session: session.clone(),
    })
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
    let provider_name = session.resolved_provider.to_ascii_lowercase();
    if title.contains(&query) {
        score += 80;
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
    if terminal.title.trim().is_empty() || terminal.title.eq_ignore_ascii_case("terminal") {
        provider_display_name(&session.resolved_provider)
    } else {
        terminal.title.clone()
    }
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
) -> Result<(), String> {
    let snapshot = fresh_snapshot(app, invocation, target).await?;
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
        Some(session_id_for(&snapshot)),
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
            return Err("prompt agente non valido".to_string());
        }
    };
    if app
        .state::<TerminalManager>()
        .write_typed_for_generation(
            app,
            &target.terminal.terminal_id,
            snapshot.generation,
            &bytes,
            TerminalInputOrigin::JarvisPrompt,
        )
        .await
        .is_err()
    {
        emit_checkpoint(
            app,
            &invocation.request_id,
            &invocation.target_workspace_id,
            "writing",
            "Scrittura non riuscita.",
            JarvisActivityStatus::Failed,
            None,
        );
        return Err("non sono riuscito a scrivere nella PTY".to_string());
    }
    app.state::<crate::jarvis::JarvisState>()
        .registry
        .observe_jarvis_send(&snapshot, prompt, &now());
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "writing",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    Ok(())
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
    {
        return Err("la generazione o la workspace del terminale è cambiata".to_string());
    }
    if !snapshot.process_alive || !snapshot.is_agent_terminal {
        return Err("il processo agente non è più vivo".to_string());
    }
    if !app
        .state::<crate::jarvis::JarvisState>()
        .registry
        .control_allowed(&snapshot.terminal_id, snapshot.generation)
    {
        return Err("l'identità dell'agente non è sufficientemente verificata".to_string());
    }
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
                && intent.terminal_id.as_deref() == Some(target.terminal.terminal_id.as_str())
                && intent.generation == Some(target.terminal.generation)
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
                && intent.terminal_id.as_deref() == Some(target.terminal.terminal_id.as_str())
                && intent.generation == Some(target.terminal.generation)
        })
}

#[derive(Debug)]
enum OpenResult {
    Opened {
        provider: String,
        sent: bool,
        terminal_id: String,
        generation: u64,
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
    let config = TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id: Some(provider.clone()),
        command: Some(definition.command.clone()),
        cwd: workspace.root_path.clone(),
        title: definition.name.clone(),
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
        if let Err(error) = send_to_target(
            app,
            invocation,
            &ResolvedAgentTarget {
                terminal: terminal_summary_for_config(&config, snapshot.generation),
                session: synthetic_session(&config, snapshot.generation),
            },
            &prompt,
        )
        .await
        {
            rollback_open_agent(app, &workspace, &terminal_id, &runtime).await;
            return Err(error);
        }
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
        terminal_id,
        generation: runtime.generation,
    })
}

fn provider_command(definition: &AgentDefinition) -> String {
    if definition.args.is_empty() {
        format!("{}\r", definition.command)
    } else {
        format!("{} {}\r", definition.command, definition.args.join(" "))
    }
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
        Some(session_id_for(&snapshot)),
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
        // Free text is not a provider token; the backend must clarify.
        assert_eq!(normalize_plan_provider(" agente P "), None);
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
}
