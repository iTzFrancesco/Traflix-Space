//! Target resolution, binding safety, and bounded terminal evidence.

use super::dispatch::put_clarification;
use super::support::*;
use super::*;
use crate::jarvis::actions::validate_agent_text;
use crate::terminal_engine::TerminalManager;
use std::collections::HashSet;
use tauri::Manager;

pub(super) fn merge_step_with_pending(
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

pub(super) fn binding_for_target(target: &ResolvedAgentTarget) -> AgentAssignmentBinding {
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

pub(super) fn recipient_from_target(
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

pub(super) fn target_from_binding(
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

pub(super) fn bound_target_from_pending(
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
    incoming_step: &ConversationStep,
) -> Result<Option<ResolvedAgentTarget>, String> {
    if !step.confirmed
        && !step.allow_busy
        && !automatic_follow_up_requested(pending, step, incoming_step)
    {
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

pub(super) fn automatic_follow_up_requested(
    pending: Option<&PendingConversationalIntent>,
    step: &ConversationStep,
    incoming_step: &ConversationStep,
) -> bool {
    // A typed follow-up may name the stable alias explicitly. A continuation
    // of a pending busy clarification must omit a new target so its stored
    // binding remains authoritative.
    if step.follow_up {
        return true;
    }
    let no_explicit_target = incoming_step
        .target
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        && incoming_step
            .provider
            .as_deref()
            .is_none_or(|value| value.trim().is_empty());
    if !no_explicit_target {
        return false;
    }
    pending.is_some_and(|intent| {
        intent.kind == PendingConversationKind::Clarification
            && intent.operation == PlanOperation::AgentSend
            && intent.binding.is_some()
    })
}

pub(super) fn target_or_clarify(
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

pub(super) fn reject_reused_target(
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

pub(super) async fn resolve_target(
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

pub(super) fn score_candidate(
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

pub(super) fn token_overlap(left: &str, right: &str) -> i32 {
    let right = right.to_ascii_lowercase();
    left.split(|character: char| !character.is_alphanumeric())
        .filter(|token| token.len() >= 2 && right.contains(token))
        .count() as i32
}

pub(super) fn display_candidate(
    session: &AgentSessionContext,
    terminal: &TerminalSummary,
) -> String {
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

pub(super) fn target_label(target: &ResolvedAgentTarget) -> String {
    display_candidate(&target.session, &target.terminal)
}

pub(super) fn is_busy(session: &AgentSessionContext) -> bool {
    matches!(session.state, AgentState::Starting | AgentState::Working)
}

pub(super) async fn read_agent_tail(
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

pub(super) async fn source_evidence(
    app: &AppHandle,
    source: &ResolvedAgentTarget,
) -> Result<String, String> {
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

pub(super) fn build_handoff_prompt(
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

pub(super) fn confirmation_matches(
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

pub(super) fn batch_confirmation_matches(
    confirmation_bindings: Option<&[AgentAssignmentBinding]>,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
) -> bool {
    matches!(step.operation, PlanOperation::TerminalClose)
        && confirmation_bindings.is_some_and(|bindings| {
            bindings
                .iter()
                .any(|binding| binding_matches_target(binding, target))
        })
}

pub(super) fn busy_override_matches(
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

pub(super) fn binding_matches_target(
    binding: &AgentAssignmentBinding,
    target: &ResolvedAgentTarget,
) -> bool {
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
