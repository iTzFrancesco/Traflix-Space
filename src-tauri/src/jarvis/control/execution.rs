//! Plan execution and typed PTY dispatch.

use super::dispatch::*;
use super::lifecycle::{close_target, open_agent, OpenResult};
use super::reactivation::{
    ensure_target_runtime_for_prompt, reactivate_bound_agent, reactivate_explicit_agent,
    restart_target,
};
use super::routing::*;
use super::support::*;
use super::*;
use crate::jarvis::actions::validate_agent_text;
use crate::jarvis::tools::{
    attach_terminal_titles, list_terminals_for_workspace, JarvisToolService,
};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use futures_util::future::join_all;
use std::collections::HashSet;
use tauri::Manager;
use tokio_util::sync::CancellationToken;
use tracing::info;

#[derive(Debug, Clone)]
pub(super) struct StepExecutionOutcome {
    response: String,
    status: &'static str,
    target: Option<String>,
    recipient: Option<AgentRecipientReceipt>,
    stages: Vec<&'static str>,
}

pub(super) fn plain_outcome(response: String) -> StepExecutionOutcome {
    StepExecutionOutcome {
        response,
        status: "succeeded",
        target: None,
        recipient: None,
        stages: Vec::new(),
    }
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
    let mut confirmation_bindings = if pending.is_some() {
        state
            .control
            .confirmation_bindings(&invocation.target_workspace_id)
    } else {
        None
    };
    state.control.clear(&invocation.target_workspace_id);
    let mut response = plan.response.clone().unwrap_or_default();
    let mut warnings = Vec::new();
    let mut receipts = Vec::new();
    let mut reserved_terminal_ids = HashSet::new();

    if pending.is_none() {
        let batch_context = if operations.len() > 1
            && operations
                .iter()
                .all(|step| step.operation == PlanOperation::TerminalClose)
        {
            refresh_operational_context(app, workspace, invocation, context)
                .await
                .ok()
        } else {
            None
        };
        if let Some(batch_context) = batch_context {
            if let Some(prepared) =
                prepare_terminal_close_batch(app, &batch_context, &operations).await
            {
                let has_busy_target = prepared.iter().any(|(_, target)| is_busy(&target.session));
                let batch_bindings = prepared
                    .iter()
                    .map(|(_, target)| binding_for_target(target))
                    .collect::<Vec<_>>();
                if has_busy_target && operations.iter().all(|step| step.confirmed) {
                    confirmation_bindings = Some(batch_bindings);
                } else if has_busy_target {
                    let labels = prepared
                        .iter()
                        .map(|(_, target)| target_label(target))
                        .collect::<Vec<_>>();
                    let question = format!(
                        "I terminali {} sono ancora attivi. Li chiudo tutti comunque?",
                        labels.join(", ")
                    );
                    put_batch_confirmation(
                        app,
                        invocation,
                        &operations,
                        &prepared,
                        question.clone(),
                    );
                    return ControlExecution {
                        response: question.clone(),
                        warnings: vec!["batch_confirmation_required".to_string()],
                        steps: vec![StepExecutionReceipt {
                            operation: PlanOperation::TerminalClose,
                            status: "paused",
                            target: Some(labels.join(", ")),
                            message: question,
                            recipient: None,
                            stages: Vec::new(),
                        }],
                    };
                }
            }
        }
    }

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
            confirmation_bindings.as_deref(),
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

pub(super) async fn refresh_operational_context(
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

pub(super) fn append_response(current: String, message: &str) -> String {
    if current.trim().is_empty() {
        message.to_string()
    } else if message.trim().is_empty() {
        current
    } else {
        format!("{current} {message}")
    }
}

pub(super) fn brief_control_error(error: &str) -> String {
    if error.starts_with("turn_failed:") {
        return "Invio agente non riuscito; il destinatario non è confermato.".to_string();
    }
    compact_response(error)
}

pub(super) fn dispatch_failure_status(error: &str) -> &'static str {
    if error.starts_with("turn_failed:") {
        DISPATCH_TURN_FAILED
    } else {
        "failed"
    }
}

pub(super) fn dispatch_failure_stages(error: &str) -> Vec<&'static str> {
    if error.starts_with("turn_failed:") {
        vec![DISPATCH_TURN_FAILED]
    } else {
        Vec::new()
    }
}

pub(super) fn should_parallelize_agent_sends(operations: &[ConversationStep]) -> bool {
    operations.len() > 1
        && operations
            .iter()
            .all(|step| step.operation == PlanOperation::AgentSend)
}

pub(super) async fn prepare_parallel_agent_sends(
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

pub(super) async fn prepare_terminal_close_batch(
    app: &AppHandle,
    context: &crate::jarvis::types::ModelContextViewV1,
    operations: &[ConversationStep],
) -> Option<Vec<(ConversationStep, ResolvedAgentTarget)>> {
    if operations.len() <= 1
        || !operations
            .iter()
            .all(|step| step.operation == PlanOperation::TerminalClose)
    {
        return None;
    }
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
        if !terminal_ids.insert(target.terminal.terminal_id.clone()) {
            return None;
        }
        prepared.push((step.clone(), target));
    }
    Some(prepared)
}

pub(super) fn operations_for_execution(
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

pub(super) fn validate_agent_dispatches(operations: &[ConversationStep]) -> Result<(), String> {
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

pub(super) async fn execute_step(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    context: &crate::jarvis::types::ModelContextViewV1,
    pending: Option<&PendingConversationalIntent>,
    confirmation_bindings: Option<&[AgentAssignmentBinding]>,
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
            let mut target_was_reactivated = false;
            let pending_target =
                match bound_target_from_pending(context, pending, step, incoming_step) {
                    Ok(target) => target,
                    Err(error)
                        if error == "agent_binding_stale_or_mismatch" && no_explicit_target =>
                    {
                        let binding = pending.and_then(|intent| intent.binding.as_ref());
                        let Some(binding) = binding else {
                            return Err(error);
                        };
                        let target =
                            reactivate_bound_agent(app, workspace, invocation, binding).await?;
                        target_was_reactivated = true;
                        Some(target)
                    }
                    Err(error) => return Err(error),
                };
            let resolution = if let Some(target) = pending_target {
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
                match target_from_binding(context, &binding) {
                    Ok(target) => TargetResolution::Selected(target),
                    Err(error) if error == "agent_binding_stale_or_mismatch" => {
                        let target =
                            reactivate_bound_agent(app, workspace, invocation, &binding).await?;
                        target_was_reactivated = true;
                        TargetResolution::Selected(target)
                    }
                    Err(error) => return Err(error),
                }
            } else {
                resolve_target(
                    app,
                    context,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await
            };
            let resolution = if resolution == TargetResolution::NotFound {
                if let Some(target) = reactivate_explicit_agent(
                    app,
                    workspace,
                    invocation,
                    step.target.as_deref(),
                    step.provider.as_deref(),
                )
                .await?
                {
                    target_was_reactivated = true;
                    TargetResolution::Selected(target)
                } else {
                    resolution
                }
            } else {
                resolution
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
            let (target, runtime_reactivated) =
                ensure_target_runtime_for_prompt(app, workspace, invocation, target).await?;
            target_was_reactivated |= runtime_reactivated;
            reject_reused_target(&reserved_terminal_ids, &target)?;
            let follow_up_binding = if no_explicit_target || step.follow_up {
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
            let automatic_follow_up = automatic_follow_up_requested(pending, step, incoming_step)
                && follow_up_binding
                    .as_ref()
                    .is_some_and(|binding| binding_matches_target(binding, &target));
            if is_busy(&target.session)
                && !automatic_follow_up
                && !busy_override_matches(pending, step, &target)
            {
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
            let dispatch = send_to_target(
                app,
                invocation,
                &target,
                &prompt,
                (!target_was_reactivated)
                    .then_some(follow_up_binding)
                    .flatten(),
            )
            .await?;
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
            if is_busy(&target.session)
                && !confirmation_matches(pending, step, &target)
                && !batch_confirmation_matches(confirmation_bindings, step, &target)
            {
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
            if is_busy(&target.session)
                && !confirmation_matches(pending, step, &target)
                && !batch_confirmation_matches(confirmation_bindings, step, &target)
            {
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
            if is_busy(&target.session)
                && !confirmation_matches(pending, step, &target)
                && !batch_confirmation_matches(confirmation_bindings, step, &target)
            {
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
