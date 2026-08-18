//! Serialized PTY dispatch and pending confirmation records.

use super::routing::*;
use super::support::*;
use super::*;
use crate::jarvis::actions::prompt_bytes;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use tauri::Manager;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub(super) struct AgentDispatchReceipt {
    pub(super) status: &'static str,
    pub(super) stages: Vec<&'static str>,
    pub(super) binding: AgentAssignmentBinding,
    pub(super) recipient: AgentRecipientReceipt,
}

pub(super) async fn send_to_target(
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
        // A PTY dispatch has no provider-level `turn/started` notification.
        // The receipt deliberately remains `submission_unconfirmed`, but the
        // local write operation itself is complete. Keeping this checkpoint
        // Running would make the compact Jarvis bar wait forever when the
        // provider is silent (or when the user muted output).
        "Scritto; avvio turno non confermato.",
        JarvisActivityStatus::Done,
        None,
    );
    Ok(AgentDispatchReceipt {
        status: DISPATCH_SUBMISSION_UNCONFIRMED,
        stages: unconfirmed_dispatch_stages(),
        recipient: recipient_from_target(&binding, target),
        binding,
    })
}

pub(super) async fn fresh_snapshot(
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

pub(super) fn put_clarification(
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

pub(super) fn put_confirmation(
    app: &AppHandle,
    invocation: &InvocationBinding,
    step: &ConversationStep,
    target: &ResolvedAgentTarget,
    question: String,
) {
    let binding = binding_for_target(target);
    app.state::<crate::jarvis::JarvisState>()
        .control
        .put(PendingConversationalIntent {
            workspace_id: invocation.target_workspace_id.clone(),
            kind: PendingConversationKind::Confirmation,
            question,
            operation: step.operation.clone(),
            terminal_id: Some(target.terminal.terminal_id.clone()),
            generation: Some(target.terminal.generation),
            binding: Some(binding.clone()),
            created_at: now(),
            expires_at: (Utc::now()
                + chrono::Duration::from_std(PENDING_CONVERSATION_TTL).unwrap_or_default())
            .to_rfc3339(),
            plan: ConversationalPlan {
                operations: vec![step.clone()],
                response: None,
            },
        });
    app.state::<crate::jarvis::JarvisState>()
        .control
        .set_confirmation_bindings(&invocation.target_workspace_id, vec![binding]);
}

pub(super) fn put_batch_confirmation(
    app: &AppHandle,
    invocation: &InvocationBinding,
    operations: &[ConversationStep],
    targets: &[(ConversationStep, ResolvedAgentTarget)],
    question: String,
) {
    let Some((first_step, first_target)) = targets.first() else {
        return;
    };
    let bindings = targets
        .iter()
        .map(|(_, target)| binding_for_target(target))
        .collect::<Vec<_>>();
    let primary = bindings.first().cloned();
    app.state::<crate::jarvis::JarvisState>()
        .control
        .put(PendingConversationalIntent {
            workspace_id: invocation.target_workspace_id.clone(),
            kind: PendingConversationKind::Confirmation,
            question,
            operation: first_step.operation.clone(),
            terminal_id: Some(first_target.terminal.terminal_id.clone()),
            generation: Some(first_target.terminal.generation),
            binding: primary,
            created_at: now(),
            expires_at: (Utc::now()
                + chrono::Duration::from_std(PENDING_CONVERSATION_TTL).unwrap_or_default())
            .to_rfc3339(),
            plan: ConversationalPlan {
                operations: operations.to_vec(),
                response: None,
            },
        });
    app.state::<crate::jarvis::JarvisState>()
        .control
        .set_confirmation_bindings(&invocation.target_workspace_id, bindings);
}

pub(super) fn put_confirmation_like_clarification(
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
