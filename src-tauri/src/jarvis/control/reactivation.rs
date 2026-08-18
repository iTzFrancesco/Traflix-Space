//! Runtime reactivation and same-terminal provider restart.

use super::dispatch::fresh_snapshot;
use super::lifecycle::{live_workspace, provider_command, wait_until_ready};
use super::support::{synthetic_session, terminal_summary_for_config, CheckpointGuard};
use super::*;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// A provider process can disappear while its PowerShell/ConPTY shell stays
/// alive. Only an explicit false observation is strong enough to trigger a
/// restart; `None` is the backwards-compatible "not observed yet" state.
fn should_reactivate_agent_prompt(agent_process_alive: Option<bool>) -> bool {
    agent_process_alive == Some(false)
}

pub(super) async fn reactivate_bound_agent(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    binding: &AgentAssignmentBinding,
) -> Result<ResolvedAgentTarget, String> {
    let workspace = live_workspace(app, workspace, invocation).await?;
    let config = workspace
        .terminals
        .iter()
        .find(|item| {
            item.id == binding.terminal_id
                && item.agent_alias.as_deref() == Some(binding.agent_alias.as_str())
        })
        .cloned()
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    let provider = config
        .agent_id
        .as_deref()
        .and_then(normalize_plan_provider)
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    if provider != binding.provider {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }

    let manager = app.state::<TerminalManager>();
    let runtime = manager
        .runtime_identity(&binding.terminal_id)
        .await
        .map_err(|_| "agent_binding_stale_or_mismatch".to_string())?;
    // The binding is deliberately stale at this point. Its terminal id,
    // alias and provider are still an authorization boundary, while
    // generation/process identity must be read from the current PTY and not
    // compared with the old binding; a normal restart rotates both values.
    if runtime.workspace_id != invocation.target_workspace_id || runtime.process_id.is_none() {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let snapshot = manager
        .get_agent_snapshot(&binding.terminal_id)
        .await
        .map_err(|_| "agent_binding_stale_or_mismatch".to_string())?
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    if !snapshot.process_alive {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let observed_presence = manager
        .refresh_agent_process_presence(
            app,
            &binding.terminal_id,
            &runtime.workspace_id,
            runtime.generation,
            runtime.process_id,
        )
        .await
        .map_err(|_| "agent_binding_stale_or_mismatch".to_string())?;
    let refreshed = manager
        .get_agent_snapshot(&binding.terminal_id)
        .await
        .map_err(|_| "agent_binding_stale_or_mismatch".to_string())?
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    if observed_presence == Some(true) && refreshed.is_agent_terminal {
        // The exact PTY lifetime is still alive and the provider was observed
        // again. The registry may have rotated its session epoch after a
        // transient child-process miss, so refresh the binding to the current
        // registry session instead of restarting a healthy OpenCode process.
        let target = target_from_current_runtime(app, &config, runtime).await?;
        if target.terminal.agent_alias.as_deref() != Some(binding.agent_alias.as_str())
            || target.session.resolved_provider != binding.provider
        {
            return Err("agent_binding_stale_or_mismatch".to_string());
        }
        return Ok(target);
    }
    if observed_presence != Some(false) && refreshed.is_agent_terminal {
        // Unknown provider presence is not enough evidence to write into the
        // shell or restart a possibly healthy agent.
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let runtime = restart_agent_runtime(
        app,
        &workspace,
        invocation,
        &refreshed,
        &config,
        "Reactivating",
    )
    .await?;
    target_from_current_runtime(app, &config, runtime).await
}

pub(super) async fn reactivate_explicit_agent(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    query: Option<&str>,
    provider: Option<&str>,
) -> Result<Option<ResolvedAgentTarget>, String> {
    let query = query.unwrap_or_default().trim();
    let provider = provider.and_then(normalize_plan_provider);
    if query.is_empty() && provider.is_none() {
        return Ok(None);
    }
    let workspace = live_workspace(app, workspace, invocation).await?;
    let mut candidates = workspace
        .terminals
        .iter()
        .filter(|config| config.agent_id.is_some())
        .filter(|config| {
            let config_provider = config.agent_id.as_deref().and_then(normalize_plan_provider);
            let alias_match = !query.is_empty()
                && config
                    .agent_alias
                    .as_deref()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(query));
            let title_match = !query.is_empty() && config.title.eq_ignore_ascii_case(query);
            let provider_match = provider
                .as_ref()
                .is_some_and(|wanted| config_provider.as_ref() == Some(wanted));
            alias_match || title_match || provider_match
        })
        .cloned()
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Ok(None);
    }
    let config = candidates.pop().expect("one reactivation candidate");
    let manager = app.state::<TerminalManager>();
    let runtime = manager.runtime_identity(&config.id).await.ok();
    let Some(runtime) = runtime else {
        return Ok(None);
    };
    if runtime.workspace_id != invocation.target_workspace_id || runtime.process_id.is_none() {
        return Ok(None);
    }
    let snapshot = manager
        .get_agent_snapshot(&config.id)
        .await
        .map_err(|_| "terminale non disponibile".to_string())?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    if !snapshot.process_alive {
        return Ok(None);
    }
    let observed_presence = manager
        .refresh_agent_process_presence(
            app,
            &config.id,
            &runtime.workspace_id,
            runtime.generation,
            runtime.process_id,
        )
        .await
        .map_err(|_| "terminale non disponibile".to_string())?;
    let snapshot = manager
        .get_agent_snapshot(&config.id)
        .await
        .map_err(|_| "terminale non disponibile".to_string())?
        .ok_or_else(|| "terminale non disponibile".to_string())?;
    if observed_presence == Some(true) && snapshot.is_agent_terminal {
        let target = target_from_current_runtime(app, &config, runtime).await?;
        let config_provider = config.agent_id.as_deref().and_then(normalize_plan_provider);
        if target.terminal.agent_alias == config.agent_alias
            && config_provider.as_deref() == Some(target.session.resolved_provider.as_str())
        {
            return Ok(Some(target));
        }
        return Ok(None);
    }
    if observed_presence != Some(false) && snapshot.is_agent_terminal {
        return Ok(None);
    }
    let runtime = restart_agent_runtime(
        app,
        &workspace,
        invocation,
        &snapshot,
        &config,
        "Reactivating",
    )
    .await?;
    Ok(Some(
        target_from_current_runtime(app, &config, runtime).await?,
    ))
}

pub(super) async fn ensure_target_runtime_for_prompt(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    target: ResolvedAgentTarget,
) -> Result<(ResolvedAgentTarget, bool), String> {
    let manager = app.state::<TerminalManager>();
    let snapshot = manager
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
        || !snapshot.process_alive
    {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let presence = manager
        .refresh_agent_process_presence(
            app,
            &snapshot.terminal_id,
            &snapshot.workspace_id,
            snapshot.generation,
            snapshot.process_id,
        )
        .await
        .map_err(|_| "agent_binding_stale_or_mismatch".to_string())?;
    let refreshed = manager
        .get_agent_snapshot(&snapshot.terminal_id)
        .await
        .map_err(|_| "terminale non disponibile".to_string())?
        .ok_or_else(|| "terminale non disponibile".to_string())?;
    if !should_reactivate_agent_prompt(presence) && refreshed.is_agent_terminal {
        return Ok((target, false));
    }

    let workspace = live_workspace(app, workspace, invocation).await?;
    let config = workspace
        .terminals
        .iter()
        .find(|item| {
            item.id == refreshed.terminal_id
                && item.agent_alias.as_deref() == target.terminal.agent_alias.as_deref()
                && item.agent_id.as_deref().and_then(normalize_plan_provider)
                    == Some(target.session.resolved_provider.clone())
        })
        .cloned()
        .ok_or_else(|| "agent_binding_stale_or_mismatch".to_string())?;
    let runtime = restart_agent_runtime(
        app,
        &workspace,
        invocation,
        &refreshed,
        &config,
        "Reactivating",
    )
    .await?;
    Ok((
        target_from_current_runtime(app, &config, runtime).await?,
        true,
    ))
}

pub(super) async fn target_from_current_runtime(
    app: &AppHandle,
    config: &TerminalConfig,
    runtime: TerminalRuntimeIdentity,
) -> Result<ResolvedAgentTarget, String> {
    let snapshot = app
        .state::<TerminalManager>()
        .get_agent_snapshot(&config.id)
        .await
        .map_err(|_| "sessione agente riattivata non disponibile".to_string())?
        .ok_or_else(|| "sessione agente riattivata non disponibile".to_string())?;
    if snapshot.workspace_id != config.workspace_id.clone().unwrap_or_default()
        || snapshot.generation != runtime.generation
        || snapshot.process_id != runtime.process_id
        || !snapshot.process_alive
        || !snapshot.is_agent_terminal
    {
        return Err("agent_binding_stale_or_mismatch".to_string());
    }
    let mut terminal = terminal_summary_for_config(config, snapshot.generation);
    terminal.process_id = snapshot.process_id;
    terminal.agent_alias = snapshot.agent_alias.clone().or(config.agent_alias.clone());
    terminal.observed_provider = snapshot.observed_provider.clone();
    terminal.resolved_provider = snapshot
        .observed_provider
        .clone()
        .or_else(|| config.agent_id.clone())
        .unwrap_or_else(|| "terminal-agent".to_string());
    terminal.detection_source = snapshot.detection_source.clone();
    terminal.detection_confidence = snapshot.detection_confidence;
    terminal.identity_warnings = snapshot.identity_warnings.clone();
    let mut session = synthetic_session(config, snapshot.generation);
    session.reference.agent_session_id = app
        .state::<crate::jarvis::JarvisState>()
        .registry
        .current_session_id(&snapshot);
    session.reference.agent_alias = terminal.agent_alias.clone();
    Ok(ResolvedAgentTarget { terminal, session })
}

pub(super) async fn restart_target(
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
    restart_agent_runtime(
        app,
        &workspace,
        invocation,
        &snapshot,
        &config,
        "Restarting",
    )
    .await?;
    Ok(())
}

/// Relaunch the provider inside the same visible terminal lifetime boundary.
/// The terminal id and alias stay stable, but generation and agent-session id
/// intentionally change after the old provider process is gone. The caller
/// must build a fresh binding from the returned runtime before writing the
/// user's prompt.
pub(super) async fn restart_agent_runtime(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    snapshot: &crate::jarvis::agent_registry::TerminalAgentSnapshot,
    config: &TerminalConfig,
    label: &str,
) -> Result<TerminalRuntimeIdentity, String> {
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
        &format!("{label} {}…", definition.name),
        JarvisActivityStatus::Running,
        Some(
            app.state::<crate::jarvis::JarvisState>()
                .registry
                .current_session_id(snapshot),
        ),
    );
    let mut checkpoint = CheckpointGuard::new(app, invocation, "restarting_agent");
    app.state::<TerminalManager>()
        .kill_generation(app, &snapshot.terminal_id, snapshot.generation)
        .await
        .map_err(|_| "non sono riuscito a fermare la sessione".to_string())?;
    app.state::<TerminalManager>()
        .spawn(app.clone(), config.clone(), 100, 30)
        .await
        .map_err(|_| "non sono riuscito a riavviare la sessione".to_string())?;
    let runtime = app
        .state::<TerminalManager>()
        .runtime_identity(&snapshot.terminal_id)
        .await
        .map_err(|_| "sessione riavviata non disponibile".to_string())?;
    if runtime.workspace_id.as_str() != workspace.id.as_str() {
        let _ = app
            .state::<TerminalManager>()
            .kill_generation(app, &snapshot.terminal_id, runtime.generation)
            .await;
        return Err("sessione riavviata associata alla workspace sbagliata".to_string());
    }
    app.state::<TerminalManager>()
        .set_backend_agent_launch_state(&snapshot.terminal_id, &runtime, "starting")
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
    let launch_write = tokio::time::timeout(
        Duration::from_secs(10),
        app.state::<TerminalManager>().write_typed_for_generation(
            app,
            &snapshot.terminal_id,
            runtime.generation,
            command.as_bytes(),
            TerminalInputOrigin::Internal,
        ),
    )
    .await;
    if !matches!(launch_write, Ok(Ok(()))) {
        let _ = app
            .state::<TerminalManager>()
            .set_backend_agent_launch_state(&snapshot.terminal_id, &runtime, "failed")
            .await;
        let _ = app.emit(
            "jarvis-agent-opened",
            AgentOpenedEvent {
                workspace_id: workspace.id.clone(),
                terminal: config.clone(),
                generation: runtime.generation,
                process_id: runtime.process_id,
                launch_state: "failed",
            },
        );
        return Err("non sono riuscito a rilanciare l'agente".to_string());
    }
    if let Err(error) = wait_until_ready(app, &snapshot.terminal_id, &runtime, &definition).await {
        let _ = app
            .state::<TerminalManager>()
            .set_backend_agent_launch_state(&snapshot.terminal_id, &runtime, "failed")
            .await;
        let _ = app.emit(
            "jarvis-agent-opened",
            AgentOpenedEvent {
                workspace_id: workspace.id.clone(),
                terminal: config.clone(),
                generation: runtime.generation,
                process_id: runtime.process_id,
                launch_state: "failed",
            },
        );
        return Err(error);
    }

    app.state::<TerminalManager>()
        .set_backend_agent_launch_state(&snapshot.terminal_id, &runtime, "ready")
        .await
        .map_err(|_| "sessione riavviata sostituita durante l'avvio".to_string())?;

    // Re-announce the same visible pane so the frontend clears any stale exit
    // state and marks the provider as already launched by the backend.
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
        "restarting_agent",
        "Done.",
        JarvisActivityStatus::Done,
        None,
    );
    checkpoint.complete();
    Ok(runtime)
}
