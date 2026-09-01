//! Shared control helpers and request-scoped bookkeeping.

use super::*;
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

static NEXT_ASSIGNMENT_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn new_assignment_id() -> String {
    format!(
        "assignment:{}:{}",
        Utc::now().timestamp_millis(),
        NEXT_ASSIGNMENT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

/// Request-scoped safety net: every running control checkpoint is closed even
/// when an early `?` return happens during PTY setup or readiness polling.
pub(super) struct CheckpointGuard {
    app: AppHandle,
    request_id: String,
    workspace_id: String,
    phase: String,
    armed: bool,
}

impl CheckpointGuard {
    pub(super) fn new(app: &AppHandle, invocation: &InvocationBinding, phase: &str) -> Self {
        Self {
            app: app.clone(),
            request_id: invocation.request_id.clone(),
            workspace_id: invocation.target_workspace_id.clone(),
            phase: phase.to_string(),
            armed: true,
        }
    }

    pub(super) fn complete(&mut self) {
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

pub(super) fn terminal_summary_for_config(
    config: &TerminalConfig,
    generation: u64,
) -> TerminalSummary {
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

pub(super) fn synthetic_session(config: &TerminalConfig, generation: u64) -> AgentSessionContext {
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

pub(super) fn build_agent_report(context: &crate::jarvis::types::ModelContextViewV1) -> String {
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

pub(super) fn provider_display_name(provider: &str) -> String {
    let value = provider.trim();
    match value.to_ascii_lowercase().as_str() {
        "anti-gravity" | "agy" => "Anti-Gravity".to_string(),
        "claude" | "cloud" => "Claude".to_string(),
        "claudex" | "cloudx" => "Claudex".to_string(),
        "codex" => "Codex".to_string(),
        "opencode" => "OpenCode".to_string(),
        "pi" | "p" => "PI".to_string(),
        "cmdc" | "command code" => "Command Code".to_string(),
        "cline" => "Cline".to_string(),
        "freebuff" => "Freebuff".to_string(),
        "grok" => "Grok".to_string(),
        _ if value.is_empty() => "agente".to_string(),
        _ => {
            let mut chars = value.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_else(|| "agente".to_string())
        }
    }
}

pub(super) fn preview_text(value: &str) -> String {
    let value = value.replace(['\r', '\n'], " ");
    let (value, _) = truncate_from_end(&value, 100);
    value
}

pub(super) fn compact_response(value: &str) -> String {
    let value = value.trim();
    let (value, _) = truncate_from_end(value, 1200);
    value
}

pub(super) fn truncate_from_end(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    (value[start..].to_string(), true)
}
