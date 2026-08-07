//! Conversational control is the seam between the model's semantic plan and
//! Traflix's real, visible PTYs. The model can propose only the typed values
//! in this module; this module owns target resolution, workspace validation,
//! bounded context, readiness and side effects.

use crate::agent::registry::AgentDefinition;
use crate::jarvis::actions::{prompt_bytes, validate_agent_text};
use crate::jarvis::agent_registry::session_id_for;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{
    AgentSessionContext, AgentState, AgentTail, InvocationBinding, Provenance, TerminalSummary,
};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use crate::workspace::registry::{TerminalConfig, WorkspaceConfig, WorkspaceRegistry};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

pub const MAX_PLAN_OPERATIONS: usize = 8;
pub const MAX_PLAN_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_HANDOFF_CONTEXT_BYTES: usize = 6 * 1024;
pub const DEFAULT_TAIL_LINES: usize = 40;
pub const MAX_TAIL_LINES: usize = 100;
pub const MAX_TAIL_BYTES: usize = 12 * 1024;
const MAX_PENDING_CONVERSATIONS: usize = 32;
const PENDING_CONVERSATION_TTL: Duration = Duration::from_secs(10 * 60);
const READINESS_TIMEOUT: Duration = Duration::from_secs(10);
const READINESS_POLL: Duration = Duration::from_millis(120);
static NEXT_AGENT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);

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
                normalize_provider(provider)
                    .ok_or_else(|| format!("provider non supportato: {provider}"))?;
            }
            for value in [&step.target, &step.source, &step.destination, &step.prompt] {
                if let Some(value) = value {
                    validate_plan_text(value)?;
                }
            }
            match step.operation {
                PlanOperation::AgentSend => {
                    validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                        .map_err(|_| "prompt agente non valido".to_string())?;
                }
                PlanOperation::AgentOpen => {
                    if let Some(prompt) = &step.prompt {
                        validate_agent_text(prompt)
                            .map_err(|_| "prompt iniziale non valido".to_string())?;
                    }
                }
                PlanOperation::AgentHandoff => {
                    validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                        .map_err(|_| "prompt handoff non valido".to_string())?;
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClosedEvent {
    pub workspace_id: String,
    pub terminal_id: String,
    pub generation: u64,
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
        let result =
            execute_step(app, workspace, invocation, context, pending.as_ref(), &step).await;
        match result {
            Ok(step_response) => {
                if !step_response.is_empty() {
                    response = step_response;
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
    step: &ConversationStep,
) -> Result<String, String> {
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
            let Some(provider) = step.provider.as_deref().and_then(normalize_provider) else {
                let question = "Quale agente vuoi aprire?".to_string();
                put_clarification(app, invocation, step, question.clone());
                return Ok(question);
            };
            let initial_prompt = step.prompt.clone().or_else(|| {
                pending
                    .filter(|intent| intent.kind == PendingConversationKind::Clarification)
                    .filter(|intent| intent.operation == PlanOperation::AgentSend)
                    .and_then(|intent| intent.plan.operations.first())
                    .and_then(|operation| operation.prompt.clone())
            });
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
            let target = resolve_target(
                app,
                context,
                step.target.as_deref(),
                step.provider.as_deref(),
            )
            .await;
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
            let destination = resolve_target(
                app,
                context,
                step.destination.as_deref().or(step.target.as_deref()),
                step.provider.as_deref(),
            )
            .await;
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
            let target = resolve_target(
                app,
                context,
                step.target.as_deref(),
                step.provider.as_deref(),
            )
            .await;
            let target =
                target_or_clarify(app, invocation, step, target, "interrompere la sessione")?;
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
                .write_typed(
                    app,
                    &target.terminal.terminal_id,
                    &[0x03],
                    TerminalInputOrigin::JarvisAbort,
                )
                .await
                .map_err(|_| "Non sono riuscito a interrompere l'agente.".to_string())?;
            let _ = snapshot;
            Ok(format!("Fatto, ho interrotto {}.", target_label(&target)))
        }
        PlanOperation::TerminalClose => {
            let target = resolve_target(
                app,
                context,
                step.target.as_deref(),
                step.provider.as_deref(),
            )
            .await;
            let target = target_or_clarify(app, invocation, step, target, "chiudere la sessione")?;
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
            let target = resolve_target(
                app,
                context,
                step.target.as_deref(),
                step.provider.as_deref(),
            )
            .await;
            let target = target_or_clarify(app, invocation, step, target, "riavviare la sessione")?;
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
            let question = if options.is_empty() {
                "Quale agente vuoi usare?".to_string()
            } else {
                format!("Quale agente vuoi usare: {}?", options.join(", "))
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
    let provider = provider.and_then(normalize_provider);
    let mut candidates = context
        .agent_sessions
        .iter()
        .filter_map(|session| {
            let terminal_id = session.reference.terminal_id.as_ref()?;
            let terminal = context
                .terminals
                .iter()
                .find(|terminal| &terminal.terminal_id == terminal_id)?;
            if terminal.workspace_id != context.invocation.target_workspace_id {
                return None;
            }
            if provider.as_deref().is_some_and(|value| {
                value != session.resolved_provider && value != session.reference.provider
            }) {
                return None;
            }
            Some((
                score_candidate(
                    query.unwrap_or_default(),
                    session,
                    terminal,
                    provider.as_deref(),
                ),
                session,
                terminal,
            ))
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return TargetResolution::NotFound;
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    let top_score = candidates[0].0;
    if candidates.len() > 1 && candidates[1].0 == top_score {
        let mut with_tail = Vec::new();
        for (_, session, terminal) in candidates.iter().take(4) {
            if let Ok(tail) = read_agent_tail(app, terminal, DEFAULT_TAIL_LINES).await {
                let tail_score = token_overlap(query.unwrap_or_default(), &tail.content);
                with_tail.push((tail_score, *session, *terminal));
            }
        }
        with_tail.sort_by(|left, right| right.0.cmp(&left.0));
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
    if top_score <= 0 && candidates.len() > 1 {
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
    let content = app
        .state::<TerminalManager>()
        .get_recent_normalized_terminal_text(&terminal.terminal_id, MAX_TAIL_BYTES)
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
    let _snapshot = fresh_snapshot(app, invocation, target).await?;
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
        Some(session_id_for(&_snapshot)),
    );
    let bytes = prompt_bytes(prompt).map_err(|_| "prompt agente non valido".to_string())?;
    app.state::<TerminalManager>()
        .write_typed(
            app,
            &target.terminal.terminal_id,
            &bytes,
            TerminalInputOrigin::JarvisPrompt,
        )
        .await
        .map_err(|_| "non sono riuscito a scrivere nella PTY".to_string())?;
    app.state::<crate::jarvis::JarvisState>()
        .registry
        .observe_jarvis_send(&_snapshot, prompt, &now());
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
                && intent.terminal_id.as_deref() == Some(&target.terminal.terminal_id)
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

async fn open_agent(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    provider: &str,
    initial_prompt: Option<String>,
) -> Result<OpenResult, String> {
    let provider = normalize_provider(provider)
        .ok_or_else(|| format!("provider non supportato: {provider}"))?;
    let definition = app
        .state::<crate::agent::registry::AgentRegistry>()
        .get_agent(&provider)
        .cloned()
        .ok_or_else(|| format!("provider non supportato: {provider}"))?;
    if workspace.id != invocation.target_workspace_id {
        return Err("workspace invocation non valida".to_string());
    }
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
    manager.spawn(app.clone(), config.clone(), 100, 30).await?;
    let mut updated = workspace.clone();
    updated.terminals.push(config.clone());
    updated.updated_at = now();
    app.state::<WorkspaceRegistry>().insert(updated).await;
    if app.state::<WorkspaceRegistry>().save().await.is_err() {
        rollback_open_agent(app, workspace, &terminal_id).await;
        return Err("non sono riuscito a registrare il nuovo terminale".to_string());
    }
    let _ = app.emit(
        "jarvis-agent-opened",
        AgentOpenedEvent {
            workspace_id: workspace.id.clone(),
            terminal: config.clone(),
        },
    );

    let command = if definition.args.is_empty() {
        format!("{}\r", definition.command)
    } else {
        format!("{} {}\r", definition.command, definition.args.join(" "))
    };
    if manager
        .write_typed(
            app,
            &terminal_id,
            command.as_bytes(),
            TerminalInputOrigin::Internal,
        )
        .await
        .is_err()
    {
        rollback_open_agent(app, workspace, &terminal_id).await;
        return Err("non sono riuscito ad avviare l'agente nella PTY".to_string());
    }
    if let Err(error) = wait_until_ready(app, &terminal_id, &definition).await {
        rollback_open_agent(app, workspace, &terminal_id).await;
        return Err(error);
    }
    let mut sent = false;
    if let Some(prompt) = initial_prompt {
        let prompt =
            validate_agent_text(&prompt).map_err(|_| "prompt iniziale non valido".to_string())?;
        let snapshot = app
            .state::<TerminalManager>()
            .get_agent_snapshot(&terminal_id)
            .await
            .map_err(|_| "sessione agente non disponibile".to_string())?
            .ok_or_else(|| "sessione agente non disponibile".to_string())?;
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
            rollback_open_agent(app, workspace, &terminal_id).await;
            return Err(error);
        }
        sent = true;
    }
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "opening_agent",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    let generation = manager
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| "sessione agente non disponibile".to_string())?
        .ok_or_else(|| "sessione agente non disponibile".to_string())?
        .generation;
    Ok(OpenResult::Opened {
        provider: definition.name,
        sent,
        terminal_id,
        generation,
    })
}

async fn rollback_open_agent(app: &AppHandle, workspace: &WorkspaceConfig, terminal_id: &str) {
    let manager = app.state::<TerminalManager>();
    let generation = manager
        .get_agent_snapshot(terminal_id)
        .await
        .ok()
        .flatten()
        .map(|snapshot| snapshot.generation)
        .unwrap_or_default();
    let _ = manager.kill(app, terminal_id).await;
    let mut rollback = workspace.clone();
    rollback
        .terminals
        .retain(|terminal| terminal.id != terminal_id);
    rollback.updated_at = now();
    app.state::<WorkspaceRegistry>().insert(rollback).await;
    let _ = app.state::<WorkspaceRegistry>().save().await;
    let _ = app.emit(
        "jarvis-agent-closed",
        AgentClosedEvent {
            workspace_id: workspace.id.clone(),
            terminal_id: terminal_id.to_string(),
            generation,
        },
    );
}

async fn wait_until_ready(
    app: &AppHandle,
    terminal_id: &str,
    definition: &AgentDefinition,
) -> Result<(), String> {
    let deadline = Instant::now() + READINESS_TIMEOUT;
    loop {
        let snapshot = app
            .state::<TerminalManager>()
            .get_agent_snapshot(terminal_id)
            .await
            .map_err(|_| "sessione agente non disponibile".to_string())?
            .ok_or_else(|| "sessione agente non disponibile".to_string())?;
        if !snapshot.process_alive {
            return Err("l'agente è terminato prima di diventare pronto".to_string());
        }
        let tail = app
            .state::<TerminalManager>()
            .get_recent_normalized_terminal_text(terminal_id, MAX_TAIL_BYTES)
            .await
            .unwrap_or_else(|_| crate::jarvis::agent_registry::NormalizedTerminalText {
                content: String::new(),
                truncated: false,
            });
        let lower = tail.content.to_ascii_lowercase();
        if definition
            .readiness_hints
            .iter()
            .any(|hint| lower.contains(&hint.to_ascii_lowercase()))
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("non ho potuto dimostrare che la TUI dell'agente è pronta".to_string());
        }
        tokio::time::sleep(READINESS_POLL).await;
    }
}

async fn close_target(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    target: &ResolvedAgentTarget,
) -> Result<(), String> {
    let snapshot = fresh_snapshot(app, invocation, target).await?;
    app.state::<TerminalManager>()
        .kill(app, &target.terminal.terminal_id)
        .await
        .map_err(|_| "non sono riuscito a chiudere il terminale".to_string())?;
    let mut updated = workspace.clone();
    updated
        .terminals
        .retain(|terminal| terminal.id != target.terminal.terminal_id);
    updated.updated_at = now();
    app.state::<WorkspaceRegistry>().insert(updated).await;
    app.state::<WorkspaceRegistry>()
        .save()
        .await
        .map_err(|_| "non sono riuscito ad aggiornare la workspace".to_string())?;
    let _ = app.emit(
        "jarvis-agent-closed",
        AgentClosedEvent {
            workspace_id: workspace.id.clone(),
            terminal_id: target.terminal.terminal_id.clone(),
            generation: snapshot.generation,
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
    let config = workspace
        .terminals
        .iter()
        .find(|item| item.id == target.terminal.terminal_id)
        .cloned()
        .ok_or_else(|| "configurazione terminale non trovata".to_string())?;
    let provider = config
        .agent_id
        .as_deref()
        .and_then(normalize_provider)
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
    app.state::<TerminalManager>()
        .kill(app, &target.terminal.terminal_id)
        .await
        .map_err(|_| "non sono riuscito a fermare la sessione".to_string())?;
    app.state::<TerminalManager>()
        .spawn(app.clone(), config.clone(), 100, 30)
        .await
        .map_err(|_| "non sono riuscito a riavviare la sessione".to_string())?;
    let generation = app
        .state::<TerminalManager>()
        .get_agent_snapshot(&target.terminal.terminal_id)
        .await
        .map_err(|_| "sessione riavviata non disponibile".to_string())?
        .ok_or_else(|| "sessione riavviata non disponibile".to_string())?
        .generation;
    let command = format!("{}\r", definition.command);
    app.state::<TerminalManager>()
        .write_typed(
            app,
            &target.terminal.terminal_id,
            command.as_bytes(),
            TerminalInputOrigin::Internal,
        )
        .await
        .map_err(|_| "non sono riuscito a rilanciare l'agente".to_string())?;
    wait_until_ready(app, &target.terminal.terminal_id, &definition).await?;
    emit_checkpoint(
        app,
        &invocation.request_id,
        &invocation.target_workspace_id,
        "restarting_agent",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    let _ = generation;
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
    if context.agent_sessions.is_empty() {
        return "Non ci sono agenti aperti in questa workspace.".to_string();
    }
    let mut parts = Vec::new();
    for session in context.agent_sessions.iter().take(8) {
        let title = context
            .terminals
            .iter()
            .find(|terminal| {
                terminal.terminal_id == session.reference.terminal_id.as_deref().unwrap_or_default()
            })
            .map(|terminal| terminal.title.clone())
            .filter(|title| !title.trim().is_empty() && !title.eq_ignore_ascii_case("terminal"))
            .unwrap_or_else(|| provider_display_name(&session.resolved_provider));
        let detail = session
            .current_task
            .as_ref()
            .map(|task| format!("sta lavorando su {}", preview_text(&task.text)))
            .unwrap_or_else(|| match session.state {
                AgentState::Working | AgentState::Starting => "sta lavorando".to_string(),
                AgentState::Waiting => "è in attesa".to_string(),
                AgentState::Completed => "ha finito".to_string(),
                AgentState::Failed => "è in errore".to_string(),
                AgentState::Aborted => "è stato interrotto".to_string(),
                AgentState::Exited => "è chiuso".to_string(),
                AgentState::Unknown => "ha stato sconosciuto".to_string(),
            });
        parts.push(format!("{title} {detail}"));
    }
    format!(
        "Hai {} agenti. {}.",
        context.agent_sessions.len(),
        parts.join(", ")
    )
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
    fn tail_is_bounded_by_lines_and_bytes_and_untrusted() {
        let tail = build_tail("w", "t", 4, "a\nb\nc\nd", 2, false);
        assert_eq!(tail.content, "c\nd");
        assert!(tail.truncated);
        assert!(tail.provenance.untrusted);
    }

    #[test]
    fn candidate_resolution_score_uses_read_only_title_and_task() {
        let terminal = TerminalSummary {
            terminal_id: "t".into(),
            workspace_id: "w".into(),
            title: "Codex Auth".into(),
            shell: "shell".into(),
            cwd: ".".into(),
            active: false,
            process_alive: true,
            agent_id: Some("codex".into()),
            configured_agent_id: Some("codex".into()),
            observed_provider: Some("codex".into()),
            resolved_provider: "codex".into(),
            detection_source: "test".into(),
            detection_confidence: 1.0,
            identity_warnings: Vec::new(),
            generation: 1,
            provenance: Provenance::trusted("test", "now"),
        };
        let session = synthetic_session(
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
        assert!(score_candidate("401", &session, &terminal, None) >= 0);
        assert!(score_candidate("auth", &session, &terminal, None) > 0);
    }
}
