use crate::jarvis::actions::{prompt_bytes, PendingAction, PendingActionStatus};
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::tools::JarvisState;
use crate::jarvis::types::{InvocationBinding, JarvisErrorEnvelope};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::provider_display_name;
use super::support::{action_error, action_failure, now};

pub async fn jarvis_confirm_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    let state = app.state::<JarvisState>();
    let record = state
        .actions
        .take_for_confirmation(&action_id, &invocation)
        .map_err(|error| action_error(error, &invocation, &observed_at))?;
    let terminal_id = record.action.terminal_id.clone().ok_or_else(|| {
        action_failure(
            "terminal target missing",
            "terminal_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    let manager = app.state::<TerminalManager>();
    let snapshot = manager
        .get_agent_snapshot(&terminal_id)
        .await
        .map_err(|_| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != invocation.target_workspace_id {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "workspace del terminale non corrisponde",
            "invocation_mismatch",
            &invocation,
            &observed_at,
        ));
    }
    if record.action.generation != Some(snapshot.generation) {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "la generazione del terminale è cambiata",
            "terminal_generation_changed",
            &invocation,
            &observed_at,
        ));
    }
    if !snapshot.process_alive {
        state
            .actions
            .finish(&action_id, PendingActionStatus::Failed);
        return Err(action_failure(
            "il processo del terminale non è vivo",
            "terminal_not_alive",
            &invocation,
            &observed_at,
        ));
    }
    let provider_label = record
        .action
        .provider
        .as_deref()
        .map(provider_display_name)
        .unwrap_or_else(|| "agente".to_string());
    let target_session_id = state.registry.current_session_id(&snapshot);
    // Explicit confirmation also confirms a manually detected agent identity
    // when the registry's confidence gate was the only remaining blocker.
    let confirmed_target = snapshot.is_agent_terminal
        && (state
            .registry
            .control_allowed(&terminal_id, snapshot.generation)
            || (state
                .registry
                .confirm_identity_for_terminal(&terminal_id, snapshot.generation)
                && state
                    .registry
                    .control_allowed(&terminal_id, snapshot.generation)));
    let result = match record.action.operation.as_str() {
        "agent_send" => {
            if !confirmed_target {
                Err("target is not a confirmed agent".to_string())
            } else {
                let text = record
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                emit_checkpoint(
                    &app,
                    &invocation.request_id,
                    &invocation.target_workspace_id,
                    "writing",
                    &format!("Writing to {provider_label}…"),
                    JarvisActivityStatus::Running,
                    Some(target_session_id.clone()),
                );
                match prompt_bytes(text) {
                    Ok(bytes) => {
                        let written = manager
                            .write_typed_for_generation(
                                &app,
                                &terminal_id,
                                snapshot.generation,
                                &bytes,
                                TerminalInputOrigin::JarvisPrompt,
                            )
                            .await;
                        if written.is_ok() {
                            state.registry.observe_jarvis_send(&snapshot, text, &now());
                        }
                        written
                    }
                    Err(_) => Err("invalid action payload".to_string()),
                }
            }
        }
        "agent_abort" => {
            if !confirmed_target {
                Err("target is not a confirmed agent".to_string())
            } else {
                emit_checkpoint(
                    &app,
                    &invocation.request_id,
                    &invocation.target_workspace_id,
                    "interrupting",
                    &format!("Interrupting {provider_label}…"),
                    JarvisActivityStatus::Running,
                    Some(target_session_id.clone()),
                );
                manager
                    .write_typed_for_generation(
                        &app,
                        &terminal_id,
                        snapshot.generation,
                        &[0x03],
                        TerminalInputOrigin::JarvisAbort,
                    )
                    .await
            }
        }
        "terminal_kill" => {
            manager
                .kill_generation(&app, &terminal_id, snapshot.generation)
                .await
        }
        _ => Err("unsupported action".to_string()),
    };
    match result {
        Ok(()) => {
            emit_checkpoint(
                &app,
                &invocation.request_id,
                &invocation.target_workspace_id,
                "sent",
                "Sent.",
                JarvisActivityStatus::Done,
                None,
            );
            state
                .actions
                .finish(&action_id, PendingActionStatus::Confirmed)
                .ok_or_else(|| {
                    action_failure(
                        "action state unavailable",
                        "action_not_pending",
                        &invocation,
                        &observed_at,
                    )
                })
        }
        Err(error) => {
            emit_checkpoint(
                &app,
                &invocation.request_id,
                &invocation.target_workspace_id,
                "writing",
                "Scrittura non riuscita.",
                JarvisActivityStatus::Failed,
                None,
            );
            state
                .actions
                .finish(&action_id, PendingActionStatus::Failed);
            let code = if error.contains("agent") {
                "target_not_agent"
            } else if error.contains("invalid") {
                "action_payload_invalid"
            } else {
                "terminal_operation_failed"
            };
            Err(action_failure(
                "operazione terminale non eseguita",
                code,
                &invocation,
                &observed_at,
            ))
        }
    }
}

pub async fn jarvis_update_pending_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
    text: String,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    let state = app.state::<JarvisState>();
    let record = state.actions.record(&action_id).ok_or_else(|| {
        action_failure(
            "operazione non trovata",
            "action_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    if record.action.invocation.request_id != invocation.request_id
        || record.action.invocation.target_workspace_id != invocation.target_workspace_id
    {
        return Err(action_failure(
            "invocation non corrispondente",
            "invocation_mismatch",
            &invocation,
            &observed_at,
        ));
    }
    let terminal_id = record.action.terminal_id.as_deref().ok_or_else(|| {
        action_failure(
            "terminal target missing",
            "terminal_not_found",
            &invocation,
            &observed_at,
        )
    })?;
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(terminal_id)
        .await
        .map_err(|_| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?
        .ok_or_else(|| {
            action_failure(
                "terminal non disponibile",
                "terminal_not_found",
                &invocation,
                &observed_at,
            )
        })?;
    if snapshot.workspace_id != invocation.target_workspace_id
        || record.action.generation != Some(snapshot.generation)
        || !snapshot.process_alive
        || !snapshot.is_agent_terminal
        || !state
            .registry
            .control_allowed(terminal_id, snapshot.generation)
    {
        return Err(action_failure(
            "target terminale non più valido",
            "terminal_generation_changed",
            &invocation,
            &observed_at,
        ));
    }
    state
        .actions
        .update_agent_send(&action_id, &invocation, &text)
        .map_err(|error| action_error(error, &invocation, &observed_at))
}

pub async fn jarvis_reject_action(
    app: AppHandle,
    action_id: String,
    invocation: InvocationBinding,
) -> Result<PendingAction, JarvisErrorEnvelope> {
    let observed_at = now();
    app.state::<JarvisState>()
        .actions
        .take_for_confirmation(&action_id, &invocation)
        .map_err(|error| action_error(error, &invocation, &observed_at))?;
    app.state::<JarvisState>()
        .actions
        .finish(&action_id, PendingActionStatus::Rejected)
        .ok_or_else(|| {
            action_failure(
                "action state unavailable",
                "action_not_pending",
                &invocation,
                &observed_at,
            )
        })
}
