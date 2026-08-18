//! Session lifecycle, epoch rotation, reconciliation, and registry snapshots.

use super::{
    activity_event, identity_from_snapshot, identity_source_priority, registry_provenance,
    sync_reference_enrichment, update_identity_from_snapshot, AgentRegistryStatus,
    AgentSessionRecord, AgentSessionRegistry, TerminalAgentSnapshot, MAX_RETAINED_SESSIONS,
    MAX_TERMINAL_HISTORY,
};
use crate::jarvis::types::{
    AgentActivityKind, AgentInteractionSource, AgentResult, AgentSessionRef, AgentState,
};
use std::collections::{HashMap, HashSet, VecDeque};

impl AgentSessionRegistry {
    pub fn observe_terminal_started(
        &self,
        terminal: &TerminalAgentSnapshot,
        observed_at: &str,
    ) -> Option<AgentSessionRef> {
        if terminal.workspace_id.trim().is_empty() {
            return None;
        }
        if !terminal.is_agent_terminal && terminal.observed_provider.is_none() {
            return None;
        }
        let identity = identity_from_snapshot(terminal);
        let epoch_key = (terminal.terminal_id.clone(), terminal.generation);
        let Ok(mut epochs) = self.session_epochs.lock() else {
            return None;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return None;
        };
        let epoch = epochs.entry(epoch_key).or_default();
        let mut session_id = session_id_for_epoch(terminal, *epoch);
        if terminal.process_alive
            && sessions
                .get(&session_id)
                .is_some_and(|record| record.state == AgentState::Exited)
        {
            *epoch = epoch.saturating_add(1);
            session_id = session_id_for_epoch(terminal, *epoch);
        }
        drop(epochs);
        mark_previous_generations_exited(&mut sessions, terminal, &session_id, observed_at);
        let record = sessions.entry(session_id.clone()).or_insert_with(|| {
            let state = if terminal.process_alive {
                AgentState::Starting
            } else {
                AgentState::Exited
            };
            AgentSessionRecord {
                reference: AgentSessionRef {
                    agent_session_id: session_id,
                    provider: identity.resolved_provider.clone(),
                    configured_agent_id: terminal.agent_id.clone(),
                    observed_provider: identity.observed_provider.clone(),
                    resolved_provider: identity.resolved_provider.clone(),
                    detection_source: identity.detection_source.clone(),
                    detection_confidence: identity.detection_confidence,
                    identity_warnings: identity.identity_warnings.clone(),
                    identity_needs_confirmation: identity.identity_needs_confirmation,
                    workspace_id: terminal.workspace_id.clone(),
                    terminal_id: Some(terminal.terminal_id.clone()),
                    agent_alias: terminal.agent_alias.clone(),
                    terminal_title: None,
                    generation: terminal.generation,
                    provider_session_id: None,
                    provider_turn_id: None,
                    created_at: observed_at.to_string(),
                    updated_at: observed_at.to_string(),
                    current_task: None,
                    last_activity_at: None,
                },
                objective: None,
                state,
                last_turn: None,
                completion_notification: None,
                last_result: None,
                provenance: registry_provenance(observed_at),
                confidence: 0.75,
                warnings: identity.identity_warnings.clone(),
                current_task: None,
                last_activity_at: None,
                activity_timeline: VecDeque::new(),
            }
        });
        update_identity_from_snapshot(record, terminal, &identity);
        if let Some(provider) = identity.observed_provider.as_deref() {
            if self
                .identity_decision(&terminal.terminal_id, terminal.generation, provider)
                .is_some()
            {
                record.reference.identity_needs_confirmation = false;
            }
        }
        record.reference.updated_at = observed_at.to_string();
        record.state = if terminal.process_alive {
            match record.state {
                AgentState::Starting
                    if identity_source_priority(&record.reference.detection_source) >= 4 =>
                {
                    AgentState::Waiting
                }
                AgentState::Exited if record.current_task.is_some() => AgentState::Working,
                AgentState::Exited => AgentState::Waiting,
                current => current,
            }
        } else {
            AgentState::Exited
        };
        let reference = record.reference.clone();
        self.prune_sessions_locked(&mut sessions);
        Some(reference)
    }

    #[cfg(test)]
    pub fn observe_input(&self, terminal: &TerminalAgentSnapshot, observed_at: &str) {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(record) = sessions.get_mut(&reference.agent_session_id) {
            record.state = AgentState::Working;
            record.reference.updated_at = observed_at.to_string();
            record.last_activity_at = Some(observed_at.to_string());
        }
    }

    pub(super) fn begin_new_session_epoch(
        &self,
        terminal: &TerminalAgentSnapshot,
        observed_at: &str,
    ) {
        let key = (terminal.terminal_id.clone(), terminal.generation);
        let Ok(mut epochs) = self.session_epochs.lock() else {
            return;
        };
        let epoch = epochs.entry(key).or_default();
        *epoch = epoch.saturating_add(1);
        let next_session_id = session_id_for_epoch(terminal, *epoch);
        drop(epochs);

        if let Ok(mut sessions) = self.sessions.lock() {
            for record in sessions.values_mut() {
                if record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
                    && record.reference.generation == terminal.generation
                    && record.reference.agent_session_id != next_session_id
                    && record.state != AgentState::Exited
                {
                    record.state = AgentState::Exited;
                    record.reference.identity_needs_confirmation = false;
                    record.reference.updated_at = observed_at.to_string();
                    record.last_activity_at = Some(observed_at.to_string());
                    record.push_activity(activity_event(
                        AgentActivityKind::Exited,
                        AgentInteractionSource::System,
                        observed_at,
                        Some("agent session reset".to_string()),
                        1.0,
                        false,
                    ));
                    sync_reference_enrichment(record);
                }
            }
        }
        self.observe_terminal_started(terminal, observed_at);
    }

    pub fn current_session_id(&self, terminal: &TerminalAgentSnapshot) -> String {
        let epoch = self
            .session_epochs
            .lock()
            .ok()
            .and_then(|epochs| {
                epochs
                    .get(&(terminal.terminal_id.clone(), terminal.generation))
                    .copied()
            })
            .unwrap_or_default();
        session_id_for_epoch(terminal, epoch)
    }

    pub(super) fn rotate_epoch_for_provider_session_change(
        &self,
        terminal: &TerminalAgentSnapshot,
        provider_session_id: &str,
        observed_at: &str,
    ) {
        let current_id = self.current_session_id(terminal);
        let changed = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&current_id).cloned())
            .and_then(|record| record.reference.provider_session_id)
            .is_some_and(|current| current != provider_session_id);
        if changed {
            self.begin_new_session_epoch(terminal, observed_at);
        }
    }

    pub fn observe_terminal_exit(&self, terminal_id: &str, generation: u64, observed_at: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if record.reference.terminal_id.as_deref() == Some(terminal_id)
                && record.reference.generation == generation
            {
                record.state = AgentState::Exited;
                // An exited terminal cannot be controlled. Clear any pending
                // manual identity gate so stale history never appears as an
                // actionable confirmation request after the PTY is closed.
                record.reference.identity_needs_confirmation = false;
                record.reference.updated_at = observed_at.to_string();
                record.last_activity_at = Some(observed_at.to_string());
                record.push_activity(activity_event(
                    AgentActivityKind::Exited,
                    AgentInteractionSource::System,
                    observed_at,
                    None,
                    1.0,
                    true,
                ));
                sync_reference_enrichment(record);
            }
        }
        self.prune_sessions_locked(&mut sessions);
    }

    pub fn reconcile(&self, terminals: &[TerminalAgentSnapshot], observed_at: &str) {
        for terminal in terminals {
            if terminal.is_agent_terminal || terminal.observed_provider.is_some() {
                self.observe_terminal_started(terminal, observed_at);
            }
        }

        let known: HashSet<(String, u64)> = terminals
            .iter()
            .filter(|terminal| terminal.is_agent_terminal || terminal.observed_provider.is_some())
            .map(|terminal| (terminal.terminal_id.clone(), terminal.generation))
            .collect();
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if let Some(terminal_id) = record.reference.terminal_id.as_deref() {
                let key = (terminal_id.to_string(), record.reference.generation);
                if !known.contains(&key) && record.state != AgentState::Exited {
                    record.state = AgentState::Exited;
                    record.reference.identity_needs_confirmation = false;
                    record.reference.updated_at = observed_at.to_string();
                }
            }
        }
        self.prune_sessions_locked(&mut sessions);
    }

    pub fn list_sessions(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AgentSessionRef>, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        let mut result = sessions
            .values()
            .filter(|record| record.reference.workspace_id == workspace_id)
            .map(|record| record.reference.clone())
            .collect::<Vec<_>>();
        result.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.agent_session_id.cmp(&right.agent_session_id))
        });
        Ok(result)
    }

    pub fn status(
        &self,
        reference: &AgentSessionRef,
    ) -> Result<AgentRegistryStatus, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        let record = sessions
            .get(&reference.agent_session_id)
            .filter(|record| record.reference.workspace_id == reference.workspace_id)
            .ok_or_else(|| crate::jarvis::agent_adapter::AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })?;
        Ok(AgentRegistryStatus {
            objective: record.objective.clone(),
            state: record.state,
            last_turn: record.last_turn.clone(),
            completion_notification: record.completion_notification.clone(),
            provenance: record.provenance.clone(),
            confidence: record.confidence,
            warnings: record.warnings.clone(),
            current_task: record.current_task.clone(),
            last_activity_at: record.last_activity_at.clone(),
            #[cfg(test)]
            activity_timeline: record.activity_timeline.iter().cloned().collect(),
        })
    }

    pub fn last_result(
        &self,
        reference: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        sessions
            .get(&reference.agent_session_id)
            .filter(|record| record.reference.workspace_id == reference.workspace_id)
            .map(|record| record.last_result.clone())
            .ok_or_else(|| crate::jarvis::agent_adapter::AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })
    }

    pub(super) fn prune_sessions_locked(&self, sessions: &mut HashMap<String, AgentSessionRecord>) {
        let selected = self
            .selected_session
            .lock()
            .ok()
            .and_then(|selected| selected.clone());
        prune_sessions(sessions, selected.as_deref());
    }
}

fn session_id_for_epoch(terminal: &TerminalAgentSnapshot, epoch: u64) -> String {
    format!(
        "agent-session:{}:{}:{}",
        terminal.terminal_id, terminal.generation, epoch
    )
}

fn prune_sessions(sessions: &mut HashMap<String, AgentSessionRecord>, selected: Option<&str>) {
    let mut by_terminal: HashMap<String, Vec<(u64, String, String)>> = HashMap::new();
    for record in sessions.values() {
        if record.state != AgentState::Exited
            || selected == Some(record.reference.agent_session_id.as_str())
        {
            continue;
        }
        let Some(terminal_id) = record.reference.terminal_id.as_ref() else {
            continue;
        };
        by_terminal.entry(terminal_id.clone()).or_default().push((
            record.reference.generation,
            record.reference.updated_at.clone(),
            record.reference.agent_session_id.clone(),
        ));
    }

    let mut remove = Vec::new();
    for (_, mut history) in by_terminal {
        history.sort();
        let keep_from = history.len().saturating_sub(MAX_TERMINAL_HISTORY);
        remove.extend(history.into_iter().take(keep_from).map(|(_, _, id)| id));
    }
    for id in remove {
        sessions.remove(&id);
    }

    if sessions.len() <= MAX_RETAINED_SESSIONS {
        return;
    }
    let mut candidates = sessions
        .values()
        .filter(|record| {
            record.state == AgentState::Exited
                && selected != Some(record.reference.agent_session_id.as_str())
        })
        .map(|record| {
            (
                record.reference.updated_at.clone(),
                record.reference.generation,
                record.reference.agent_session_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort();
    let remove_count = sessions.len().saturating_sub(MAX_RETAINED_SESSIONS);
    for (_, _, session_id) in candidates.into_iter().take(remove_count) {
        sessions.remove(&session_id);
    }
}

fn mark_previous_generations_exited(
    sessions: &mut HashMap<String, AgentSessionRecord>,
    terminal: &TerminalAgentSnapshot,
    current_session_id: &str,
    observed_at: &str,
) {
    for record in sessions.values_mut() {
        if record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
            && record.reference.workspace_id == terminal.workspace_id
            && record.reference.agent_session_id != current_session_id
            && record.reference.generation != terminal.generation
        {
            record.state = AgentState::Exited;
            record.reference.identity_needs_confirmation = false;
            record.reference.updated_at = observed_at.to_string();
            record.last_activity_at = Some(observed_at.to_string());
            record.push_activity(activity_event(
                AgentActivityKind::Exited,
                AgentInteractionSource::System,
                observed_at,
                None,
                1.0,
                true,
            ));
            sync_reference_enrichment(record);
        }
    }
}
