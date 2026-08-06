use crate::jarvis::types::{
    AgentCompletionNotification, AgentResult, AgentSessionRef, AgentState, AgentTurnContext,
    Provenance,
};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub const MAX_TERMINAL_FALLBACK_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalAgentSnapshot {
    pub terminal_id: String,
    pub workspace_id: String,
    pub is_agent_terminal: bool,
    pub agent_id: Option<String>,
    pub generation: u64,
    pub process_alive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionObservation {
    pub provider: String,
    pub event_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTerminalText {
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct AgentRegistryStatus {
    pub objective: Option<String>,
    pub state: AgentState,
    pub last_turn: Option<AgentTurnContext>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub provenance: Provenance,
    pub confidence: f32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct AgentSessionRecord {
    reference: AgentSessionRef,
    objective: Option<String>,
    state: AgentState,
    last_turn: Option<AgentTurnContext>,
    completion_notification: Option<AgentCompletionNotification>,
    last_result: Option<AgentResult>,
    provenance: Provenance,
    confidence: f32,
    warnings: Vec<String>,
}

#[derive(Default)]
pub struct AgentSessionRegistry {
    sessions: Mutex<HashMap<String, AgentSessionRecord>>,
    completion_keys: Mutex<HashSet<String>>,
}

impl AgentSessionRegistry {
    pub fn observe_terminal_started(
        &self,
        terminal: &TerminalAgentSnapshot,
        observed_at: &str,
    ) -> Option<AgentSessionRef> {
        if terminal.workspace_id.trim().is_empty() {
            return None;
        }
        if !terminal.is_agent_terminal {
            return None;
        }
        let provider = terminal
            .agent_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("terminal-agent");

        let Ok(mut sessions) = self.sessions.lock() else {
            return None;
        };
        let session_id = session_id_for(terminal);
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
                    provider: provider.to_string(),
                    workspace_id: terminal.workspace_id.clone(),
                    terminal_id: Some(terminal.terminal_id.clone()),
                    generation: terminal.generation,
                    provider_session_id: None,
                    provider_turn_id: None,
                    created_at: observed_at.to_string(),
                    updated_at: observed_at.to_string(),
                },
                objective: None,
                state,
                last_turn: None,
                completion_notification: None,
                last_result: None,
                provenance: registry_provenance(observed_at),
                confidence: 0.75,
                warnings: Vec::new(),
            }
        });
        record.reference.provider = provider.to_string();
        record.reference.updated_at = observed_at.to_string();
        record.state = if terminal.process_alive {
            match record.state {
                AgentState::Starting | AgentState::Exited => AgentState::Working,
                current => current,
            }
        } else {
            AgentState::Exited
        };
        Some(record.reference.clone())
    }

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
        }
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
            if !keys.insert(key) {
                return false;
            }
        }

        let reference = self.observe_terminal_started(terminal, observed_at);
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
        if record.reference.provider == "terminal-agent" && !observation.provider.trim().is_empty()
        {
            record.reference.provider = observation.provider.trim().to_string();
        }
        record.reference.updated_at = observed_at.to_string();
        record.state = AgentState::Waiting;
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
        record.last_result = result;
        if record.last_result.is_some() {
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
        true
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
                record.reference.updated_at = observed_at.to_string();
            }
        }
    }

    pub fn reconcile(&self, terminals: &[TerminalAgentSnapshot], observed_at: &str) {
        for terminal in terminals {
            if terminal.is_agent_terminal {
                self.observe_terminal_started(terminal, observed_at);
            }
        }

        let known: HashSet<(String, u64)> = terminals
            .iter()
            .filter(|terminal| terminal.is_agent_terminal)
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
                    record.reference.updated_at = observed_at.to_string();
                }
            }
        }
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
}

pub fn session_id_for(terminal: &TerminalAgentSnapshot) -> String {
    format!(
        "agent-session:{}:{}",
        terminal.terminal_id, terminal.generation
    )
}

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
            record.reference.updated_at = observed_at.to_string();
        }
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

fn registry_provenance(observed_at: &str) -> Provenance {
    Provenance {
        source: "terminal-registry".to_string(),
        observed_at: observed_at.to_string(),
        confidence: 0.75,
        untrusted: true,
    }
}

fn push_warning(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::super::agent_adapter::{AgentContextSource, LiveAgentContextSource};
    use super::super::types::{AgentResult, AgentState, Provenance};
    use super::{
        fallback_result_from_terminal, AgentSessionRegistry, CompletionObservation,
        TerminalAgentSnapshot,
    };

    fn terminal(generation: u64, alive: bool) -> TerminalAgentSnapshot {
        TerminalAgentSnapshot {
            terminal_id: "terminal-1".to_string(),
            workspace_id: "workspace-a".to_string(),
            is_agent_terminal: true,
            agent_id: Some("codex".to_string()),
            generation,
            process_alive: alive,
        }
    }

    fn started(registry: &AgentSessionRegistry, generation: u64) {
        registry.observe_terminal_started(&terminal(generation, true), "2026-08-07T00:00:00Z");
    }

    #[test]
    fn agent_terminal_creates_a_session_but_normal_shell_does_not() {
        let registry = AgentSessionRegistry::default();
        let mut shell = terminal(1, true);
        shell.is_agent_terminal = false;
        shell.agent_id = None;
        registry.observe_terminal_started(&shell, "now");
        assert!(registry.list_sessions("workspace-a").unwrap().is_empty());

        started(&registry, 1);
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].provider, "codex");
        assert_eq!(sessions[0].generation, 1);
    }

    #[test]
    fn sessions_are_isolated_and_generation_creates_a_new_identity() {
        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        let mut other = terminal(1, true);
        other.terminal_id = "terminal-2".to_string();
        other.workspace_id = "workspace-b".to_string();
        registry.observe_terminal_started(&other, "now");
        started(&registry, 2);

        let first = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(first.len(), 2);
        assert_ne!(first[0].agent_session_id, first[1].agent_session_id);
        assert_eq!(registry.list_sessions("workspace-b").unwrap().len(), 1);
        assert_eq!(
            registry.status(&first[0]).unwrap().state,
            AgentState::Exited
        );
    }

    #[test]
    fn input_and_completion_update_waiting_without_closing_the_session() {
        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        registry.observe_input(&terminal(1, true), "now");
        let observation = CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some("event-1".to_string()),
            provider_session_id: Some("provider-session".to_string()),
            provider_turn_id: Some("turn-1".to_string()),
            occurred_at: Some("2026-08-07T00:01:00Z".to_string()),
        };
        let result = Some(AgentResult {
            content: "done".to_string(),
            truncated: false,
            untrusted: true,
            provenance: Provenance {
                source: "terminal-fallback".to_string(),
                observed_at: "now".to_string(),
                confidence: 0.35,
                untrusted: true,
            },
        });
        assert!(registry.observe_completion(
            &terminal(1, true),
            observation.clone(),
            result,
            "now",
        ));
        assert!(!registry.observe_completion(&terminal(1, true), observation, None, "now"));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            session.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(session.provider_turn_id.as_deref(), Some("turn-1"));
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Waiting);
        assert_eq!(status.last_turn.unwrap().turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            registry.last_result(&session).unwrap().unwrap().content,
            "done"
        );

        registry.observe_input(&terminal(1, true), "later");
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Working
        );
        registry.observe_terminal_exit("terminal-1", 1, "exit");
        assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
    }

    #[test]
    fn fallback_is_normalized_bounded_and_untrusted() {
        let input = format!("first\r\nlast{}\r\n\r\n", "x".repeat(40_000));
        let result = fallback_result_from_terminal(&input, "now").unwrap();
        assert!(result.content.len() <= 32 * 1024);
        assert!(result.truncated);
        assert!(result.untrusted);
        assert_eq!(result.provenance.source, "terminal-fallback");
        assert!(result.provenance.confidence < 1.0);
        assert!(!result.content.ends_with('\n'));
    }

    #[test]
    fn live_source_exposes_registry_and_rejects_structured_messages() {
        let registry = std::sync::Arc::new(AgentSessionRegistry::default());
        started(&registry, 1);
        let source = LiveAgentContextSource::new(registry);
        let sessions = source.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            source.get_status(&sessions[0]).unwrap().state,
            AgentState::Working
        );
        let error = source.get_messages(&sessions[0]).unwrap_err();
        assert_eq!(error.code, "agent_messages_unavailable");
    }

    #[test]
    fn terminal_identity_does_not_require_provider_metadata() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.agent_id = None;
        registry.observe_terminal_started(&terminal, "now");

        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].provider, "terminal-agent");

        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: String::new(),
                event_id: Some("event-without-provider".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            None,
            "now",
        ));
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry
            .status(&session)
            .unwrap()
            .warnings
            .iter()
            .any(|warning| warning == "completion observed, result unavailable"));
        assert!(registry.last_result(&session).unwrap().is_none());
    }

    #[test]
    fn reconciliation_is_idempotent_and_marks_missing_terminals_exited() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.reconcile(std::slice::from_ref(&terminal), "first");
        registry.reconcile(std::slice::from_ref(&terminal), "second");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(registry.list_sessions("workspace-a").unwrap().len(), 1);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Working
        );

        registry.reconcile(&[], "third");
        assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
    }
}
