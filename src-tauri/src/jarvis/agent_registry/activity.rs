//! Task, activity, output, completion, and terminal-fallback observations.

use super::InputTracker;
use super::TrackerSignal;
use super::{
    activity_event, bounded_excerpt, bounded_task_text, is_agent_launch_command,
    is_local_agent_command, is_session_reset_command, normalize_observed_provider, push_warning,
    sync_reference_enrichment, AgentSessionRegistry, CompletionObservation, TerminalAgentSnapshot,
    MAX_ACTIVITY_EXCERPT_BYTES, MAX_ACTIVITY_LIMIT, MAX_INPUT_TRACKERS,
    MAX_TERMINAL_FALLBACK_BYTES, OUTPUT_ACTIVITY_THROTTLE_SECS, WORKING_ACTIVITY_MIN_GAP_SECS,
};
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{
    AgentActivityEvent, AgentActivityKind, AgentCompletionNotification, AgentInteractionSource,
    AgentResult, AgentSessionRef, AgentState, AgentTaskContext, AgentTurnContext, Provenance,
};
use std::collections::HashMap;

impl AgentSessionRegistry {
    pub fn observe_user_input(
        &self,
        terminal: &TerminalAgentSnapshot,
        data: &[u8],
        observed_at: &str,
    ) {
        let Some(mut reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        let Ok(mut trackers) = self.input_trackers.lock() else {
            return;
        };
        let key = (terminal.terminal_id.clone(), terminal.generation);
        let tracker = trackers.entry(key.clone()).or_default();
        let signals = tracker.feed(data);
        if trackers.len() > MAX_INPUT_TRACKERS {
            self.prune_input_trackers_locked(&mut trackers);
        }
        drop(trackers);

        for signal in signals {
            match signal {
                TrackerSignal::Committed(text) => {
                    if is_agent_launch_command(&text) {
                        // Launching the CLI is session startup, not a task.
                        continue;
                    }
                    if is_session_reset_command(&text) {
                        self.begin_new_session_epoch(terminal, observed_at);
                        if let Some(next) = self.observe_terminal_started(terminal, observed_at) {
                            reference = next;
                        }
                        continue;
                    }
                    let local_command = is_local_agent_command(&text);
                    let excerpt = bounded_excerpt(&text, MAX_ACTIVITY_EXCERPT_BYTES);
                    let Ok(mut sessions) = self.sessions.lock() else {
                        return;
                    };
                    let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
                        continue;
                    };
                    record.reference.updated_at = observed_at.to_string();
                    record.last_activity_at = Some(observed_at.to_string());
                    if local_command {
                        // Slash commands are real activity but do not imply a
                        // new work turn and never replace the main task/state.
                        record.push_activity(activity_event(
                            AgentActivityKind::PromptSubmitted,
                            AgentInteractionSource::User,
                            observed_at,
                            Some(excerpt),
                            0.7,
                            true,
                        ));
                    } else {
                        record.state = AgentState::Working;
                        record.current_task = Some(AgentTaskContext {
                            text: bounded_task_text(&text),
                            source: AgentInteractionSource::User,
                            started_at: observed_at.to_string(),
                            completed_at: None,
                            confidence: 0.65,
                            untrusted: true,
                        });
                        record.push_activity(activity_event(
                            AgentActivityKind::PromptSubmitted,
                            AgentInteractionSource::User,
                            observed_at,
                            Some(excerpt),
                            0.65,
                            true,
                        ));
                    }
                    sync_reference_enrichment(record);
                }
                TrackerSignal::Interrupted => {
                    let Ok(mut sessions) = self.sessions.lock() else {
                        return;
                    };
                    let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
                        continue;
                    };
                    record.last_activity_at = Some(observed_at.to_string());
                    // A Ctrl+C may abort a running turn or only clear the
                    // line; without proof we never mark the task completed.
                    record.push_activity(activity_event(
                        AgentActivityKind::Interrupted,
                        AgentInteractionSource::User,
                        observed_at,
                        None,
                        0.6,
                        true,
                    ));
                    sync_reference_enrichment(record);
                }
            }
        }
    }

    /// Record a task originated by Jarvis. The caller must invoke this only
    /// AFTER a successful PTY write of a confirmed Pending Action; generation
    /// and liveness are re-validated by the caller before the write.
    pub fn observe_jarvis_send(
        &self,
        terminal: &TerminalAgentSnapshot,
        text: &str,
        observed_at: &str,
    ) {
        let session_id = self.current_session_id(terminal);
        let _ = self.observe_jarvis_send_for_session(terminal, &session_id, text, observed_at);
    }

    /// Record a Jarvis task only for the exact session that was validated by
    /// the dispatcher. A new session on the same terminal is an error, not a
    /// reason to silently rebind the follow-up.
    pub fn observe_jarvis_send_for_session(
        &self,
        terminal: &TerminalAgentSnapshot,
        expected_session_id: &str,
        text: &str,
        observed_at: &str,
    ) -> Result<(), String> {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return Err("agent_session_not_found".to_string());
        };
        if reference.agent_session_id != expected_session_id {
            return Err("agent_session_stale".to_string());
        }
        let excerpt = bounded_excerpt(text, MAX_ACTIVITY_EXCERPT_BYTES);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "agent_registry_unavailable".to_string())?;
        let record = sessions
            .get_mut(&reference.agent_session_id)
            .ok_or_else(|| "agent_session_not_found".to_string())?;
        record.state = AgentState::Working;
        record.reference.updated_at = observed_at.to_string();
        record.last_activity_at = Some(observed_at.to_string());
        record.current_task = Some(AgentTaskContext {
            text: bounded_task_text(text),
            source: AgentInteractionSource::Jarvis,
            started_at: observed_at.to_string(),
            completed_at: None,
            // The backend knows exactly which bytes were written.
            confidence: 0.95,
            untrusted: false,
        });
        record.push_activity(activity_event(
            AgentActivityKind::PromptSubmitted,
            AgentInteractionSource::Jarvis,
            observed_at,
            Some(excerpt),
            0.95,
            false,
        ));
        sync_reference_enrichment(record);
        Ok(())
    }

    /// Record a confirmed, successfully written `agent.abort` (Ctrl+C). The
    /// task is intentionally NOT marked completed: without proof, we only
    /// record the interruption.
    pub fn observe_abort(&self, terminal: &TerminalAgentSnapshot, observed_at: &str) {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        if let Ok(mut trackers) = self.input_trackers.lock() {
            trackers.remove(&(terminal.terminal_id.clone(), terminal.generation));
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
            return;
        };
        record.last_activity_at = Some(observed_at.to_string());
        record.push_activity(activity_event(
            AgentActivityKind::Interrupted,
            AgentInteractionSource::Jarvis,
            observed_at,
            None,
            0.9,
            false,
        ));
        sync_reference_enrichment(record);
    }

    /// Throttled (max once per second per session) update of `lastActivityAt`
    /// from terminal output. Output is never stored and never becomes a task.
    pub fn observe_output(&self, terminal_id: &str, generation: u64, observed_at: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if record.reference.terminal_id.as_deref() != Some(terminal_id)
                || record.reference.generation != generation
                || record.state == AgentState::Exited
            {
                continue;
            }
            let due = record.last_activity_at.as_deref().is_none_or(|last| {
                seconds_since(last, observed_at) >= OUTPUT_ACTIVITY_THROTTLE_SECS
            });
            if due {
                record.last_activity_at = Some(observed_at.to_string());
            }
            break;
        }
    }

    /// Test seam: output silence is diagnostic only and never proves that a
    /// turn completed. Production has no idle-completion watcher.
    #[cfg(test)]
    pub(super) fn mark_idle_sessions_completed(&self, observed_at: &str) -> Vec<String> {
        let _ = observed_at;
        Vec::new()
    }

    /// Append a throttled `working` activity while the user is actively
    /// typing into a session that already has a task.
    pub fn observe_user_typing(
        &self,
        terminal: &TerminalAgentSnapshot,
        data: &[u8],
        observed_at: &str,
    ) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(record) = sessions.values_mut().find(|record| {
            record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
                && record.reference.generation == terminal.generation
                && record.state != AgentState::Exited
        }) else {
            return;
        };
        if record.current_task.is_none() || data.is_empty() {
            return;
        }
        record.last_activity_at = Some(observed_at.to_string());
        let working_due = record.activity_timeline.back().map_or(true, |last| {
            last.kind != AgentActivityKind::Working
                || seconds_since(&last.occurred_at, observed_at) >= WORKING_ACTIVITY_MIN_GAP_SECS
        });
        if working_due {
            record.push_activity(activity_event(
                AgentActivityKind::Working,
                AgentInteractionSource::User,
                observed_at,
                None,
                0.5,
                true,
            ));
        }
    }

    pub fn activity(
        &self,
        reference: &AgentSessionRef,
        limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, crate::jarvis::agent_adapter::AgentSourceError> {
        let limit = limit.clamp(1, MAX_ACTIVITY_LIMIT);
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
        Ok(record
            .activity_timeline
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect())
    }

    fn prune_input_trackers_locked(&self, trackers: &mut HashMap<(String, u64), InputTracker>) {
        let Ok(sessions) = self.sessions.lock() else {
            return;
        };
        trackers.retain(|(terminal_id, generation), _| {
            sessions.values().any(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id.as_str())
                    && record.reference.generation == *generation
            })
        });
    }

    pub fn observe_completion(
        &self,
        terminal: &TerminalAgentSnapshot,
        observation: CompletionObservation,
        result: Option<AgentResult>,
        observed_at: &str,
    ) -> bool {
        if let Some(key) = completion_key(terminal, &observation) {
            let Ok(mut keys) = self.completion_keys.lock() else {
                return false;
            };
            if !keys.accept(key) {
                return false;
            }
        }

        let mut completion_terminal = terminal.clone();
        completion_terminal.is_agent_terminal = true;
        completion_terminal.observed_provider = normalize_observed_provider(&observation.provider);
        completion_terminal.detection_source = "completion-event".to_string();
        completion_terminal.detection_confidence = 1.0;
        if let Some(provider) = completion_terminal.observed_provider.as_deref() {
            self.clear_identity_decision(
                &completion_terminal.terminal_id,
                completion_terminal.generation,
                provider,
            );
        }
        if let Some(provider_session_id) = observation
            .provider_session_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            self.rotate_epoch_for_provider_session_change(
                &completion_terminal,
                provider_session_id,
                observed_at,
            );
        }
        let reference = self.observe_terminal_started(&completion_terminal, observed_at);
        let Some(reference) = reference else {
            return false;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
            return false;
        };

        record.reference.provider_session_id = observation.provider_session_id.clone();
        record.reference.provider_turn_id = observation.provider_turn_id.clone();
        if let Some(observed_provider) = normalize_observed_provider(&observation.provider) {
            if let Some(configured) = record.reference.configured_agent_id.as_deref() {
                let configured_provider: Option<String> = normalize_provider(configured);
                if configured_provider.as_deref() != Some(observed_provider.as_str()) {
                    let warning = format!(
                        "Identity mismatch: configured agent '{}' but observed provider '{}'",
                        configured, observed_provider
                    );
                    push_warning(&mut record.reference.identity_warnings, &warning);
                    push_warning(&mut record.warnings, &warning);
                }
            }
            record.reference.observed_provider = Some(observed_provider.clone());
            record.reference.resolved_provider = observed_provider.clone();
            record.reference.provider = observed_provider;
            record.reference.detection_source = "completion-event".to_string();
            record.reference.detection_confidence = 1.0;
            record.reference.identity_needs_confirmation = false;
        }
        record.reference.updated_at = observed_at.to_string();
        record.state = AgentState::Waiting;
        record.last_activity_at = Some(observed_at.to_string());
        if let Some(task) = record.current_task.as_mut() {
            task.completed_at = Some(observed_at.to_string());
        }
        record.push_activity(activity_event(
            AgentActivityKind::CompletionObserved,
            AgentInteractionSource::System,
            observed_at,
            None,
            1.0,
            true,
        ));
        sync_reference_enrichment(record);
        record.last_turn = Some(AgentTurnContext {
            turn_id: observation.provider_turn_id,
            state: AgentState::Waiting,
            objective: record.objective.clone(),
            occurred_at: observation.occurred_at,
            untrusted: true,
        });
        record.completion_notification = Some(AgentCompletionNotification {
            event_id: observation.event_id,
            observed_at: observed_at.to_string(),
            result_available: result.is_some(),
            untrusted: true,
        });
        let result_available = result.is_some();
        if result_available {
            record.last_result = result;
            record.push_activity(activity_event(
                AgentActivityKind::ResultAvailable,
                AgentInteractionSource::System,
                observed_at,
                None,
                0.35,
                true,
            ));
        }
        if result_available {
            push_warning(
                &mut record.warnings,
                "Result captured from terminal fallback; structured messages unavailable",
            );
        } else {
            push_warning(
                &mut record.warnings,
                "completion observed, result unavailable",
            );
        }
        self.prune_sessions_locked(&mut sessions);
        true
    }
}

#[cfg(test)]
pub fn fallback_result_from_terminal(text: &str, observed_at: &str) -> Option<AgentResult> {
    fallback_result_from_terminal_with_truncation(text, false, observed_at)
}

pub fn fallback_result_from_terminal_with_truncation(
    text: &str,
    input_truncated: bool,
    observed_at: &str,
) -> Option<AgentResult> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_end_matches('\n');
    if normalized.trim().is_empty() {
        return None;
    }
    let truncated = input_truncated || normalized.len() > MAX_TERMINAL_FALLBACK_BYTES;
    let content = if truncated {
        let mut start = normalized.len() - MAX_TERMINAL_FALLBACK_BYTES;
        while !normalized.is_char_boundary(start) {
            start += 1;
        }
        normalized[start..].to_string()
    } else {
        normalized.to_string()
    };
    Some(AgentResult {
        content,
        truncated,
        untrusted: true,
        provenance: Provenance {
            source: "terminal-fallback".to_string(),
            observed_at: observed_at.to_string(),
            confidence: 0.35,
            untrusted: true,
        },
    })
}

/// Approximate seconds between two RFC3339 timestamps produced by the same
/// clock. Used only for throttling decisions, never for absolute time.
fn seconds_since(earlier: &str, later: &str) -> u64 {
    let parse = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|dt| dt.timestamp())
    };
    match (parse(earlier), parse(later)) {
        (Some(a), Some(b)) => (b - a).max(0) as u64,
        _ => u64::MAX,
    }
}

fn completion_key(
    terminal: &TerminalAgentSnapshot,
    observation: &CompletionObservation,
) -> Option<String> {
    observation
        .event_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|event_id| {
            format!(
                "{}:{}:event:{}",
                terminal.terminal_id, terminal.generation, event_id
            )
        })
        .or_else(|| {
            let session = observation
                .provider_session_id
                .as_deref()
                .unwrap_or_default();
            let turn = observation.provider_turn_id.as_deref().unwrap_or_default();
            (!session.is_empty() || !turn.is_empty()).then(|| {
                format!(
                    "{}:{}:{}:{}",
                    terminal.terminal_id, terminal.generation, session, turn
                )
            })
        })
}
