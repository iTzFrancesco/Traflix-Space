//! Agent opening, closing, and readiness verification.

use super::dispatch::{fresh_snapshot, send_to_target, AgentDispatchReceipt};
use super::support::{synthetic_session, terminal_summary_for_config, CheckpointGuard};
use super::*;
use crate::jarvis::actions::validate_agent_text;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::terminal_engine::{TerminalInputOrigin, TerminalManager};
use crate::workspace::registry::WorkspaceRegistry;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tracing::{info, warn};

static NEXT_AGENT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_POLL: Duration = Duration::from_millis(120);

#[derive(Debug)]
pub(super) enum OpenResult {
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

pub(super) async fn live_workspace(
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

pub(super) async fn open_agent(
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

pub(super) fn provider_command(definition: &AgentDefinition) -> String {
    if definition.args.is_empty() {
        format!("{}\r", definition.command)
    } else {
        format!("{} {}\r", definition.command, definition.args.join(" "))
    }
}

pub(super) fn allocate_agent_alias(workspace: &WorkspaceConfig, provider: &str) -> String {
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

pub(super) fn automatic_agent_title(provider: &str, prompt: Option<&str>) -> String {
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

pub(super) async fn rollback_open_agent(
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

pub(super) async fn wait_until_ready(
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
pub(super) enum ReadinessEvidence {
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

pub(super) fn validate_readiness_runtime(
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

pub(super) fn readiness_evidence(
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

pub(super) fn startup_failure_code(normalized_tail: &str) -> Option<&'static str> {
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

pub(super) async fn close_target(
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
