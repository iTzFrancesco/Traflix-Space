use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{
    AgentCompletionNotification, AgentResult, AgentSessionRef, AgentState, AgentTurnContext,
    Provenance,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

pub const MAX_TERMINAL_FALLBACK_BYTES: usize = 32 * 1024;
const MAX_RETAINED_SESSIONS: usize = 256;
const MAX_TERMINAL_HISTORY: usize = 20;
const MAX_COMPLETION_KEYS: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct TerminalAgentSnapshot {
    pub terminal_id: String,
    pub workspace_id: String,
    pub is_agent_terminal: bool,
    pub agent_id: Option<String>,
    pub observed_provider: Option<String>,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
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

#[derive(Debug, Clone)]
struct ResolvedIdentity {
    observed_provider: Option<String>,
    resolved_provider: String,
    detection_source: String,
    detection_confidence: f32,
    identity_warnings: Vec<String>,
    identity_needs_confirmation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityDecision {
    Confirmed,
    Ignored,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct IdentityDecisionKey {
    terminal_id: String,
    generation: u64,
    provider: String,
}

#[derive(Default)]
struct BoundedCompletionKeys {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl BoundedCompletionKeys {
    fn accept(&mut self, key: String) -> bool {
        if self.set.contains(&key) {
            return false;
        }
        self.set.insert(key.clone());
        self.order.push_back(key);
        while self.order.len() > MAX_COMPLETION_KEYS {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
        true
    }
}

#[derive(Default)]
pub struct AgentSessionRegistry {
    sessions: Mutex<HashMap<String, AgentSessionRecord>>,
    completion_keys: Mutex<BoundedCompletionKeys>,
    identity_decisions: Mutex<HashMap<IdentityDecisionKey, IdentityDecision>>,
    selected_session: Mutex<Option<String>>,
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
        if !terminal.is_agent_terminal && terminal.observed_provider.is_none() {
            return None;
        }
        let identity = identity_from_snapshot(terminal);

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
                warnings: identity.identity_warnings.clone(),
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
                AgentState::Starting | AgentState::Exited => AgentState::Working,
                current => current,
            }
        } else {
            AgentState::Exited
        };
        let reference = record.reference.clone();
        self.prune_sessions_locked(&mut sessions);
        Some(reference)
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
                if normalize_provider(configured).as_deref() != Some(observed_provider.as_str()) {
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

    pub fn set_identity_decision(
        &self,
        terminal_id: &str,
        generation: u64,
        provider: &str,
        decision: IdentityDecision,
    ) {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        if key.provider.is_empty() {
            return;
        }
        if let Ok(mut decisions) = self.identity_decisions.lock() {
            decisions.insert(key.clone(), decision);
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(record) = sessions.values_mut().find(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id)
                    && record.reference.generation == generation
                    && record.reference.resolved_provider == key.provider
            }) {
                record.reference.identity_needs_confirmation = false;
            }
        }
    }

    pub fn clear_identity_decision(&self, terminal_id: &str, generation: u64, provider: &str) {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        if let Ok(mut decisions) = self.identity_decisions.lock() {
            decisions.remove(&key);
        }
    }

    pub fn mark_selected(&self, reference: &AgentSessionRef) {
        if let Ok(mut selected) = self.selected_session.lock() {
            *selected = Some(reference.agent_session_id.clone());
        }
    }

    fn identity_decision(
        &self,
        terminal_id: &str,
        generation: u64,
        provider: &str,
    ) -> Option<IdentityDecision> {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        self.identity_decisions
            .lock()
            .ok()
            .and_then(|decisions| decisions.get(&key).copied())
    }

    fn prune_sessions_locked(&self, sessions: &mut HashMap<String, AgentSessionRecord>) {
        let selected = self
            .selected_session
            .lock()
            .ok()
            .and_then(|selected| selected.clone());
        prune_sessions(sessions, selected.as_deref());
    }
}

pub fn session_id_for(terminal: &TerminalAgentSnapshot) -> String {
    format!(
        "agent-session:{}:{}",
        terminal.terminal_id, terminal.generation
    )
}

fn identity_from_snapshot(terminal: &TerminalAgentSnapshot) -> ResolvedIdentity {
    let observed_provider = terminal
        .observed_provider
        .as_deref()
        .and_then(normalize_observed_provider);
    let configured_provider = terminal
        .agent_id
        .as_deref()
        .and_then(|value| {
            normalize_provider(value).or_else(|| Some(value.trim().to_ascii_lowercase()))
        })
        .filter(|value| !value.is_empty());
    let (resolved_provider, detection_source, detection_confidence) =
        if let Some(observed) = observed_provider.clone() {
            (
                observed,
                if terminal.detection_source.trim().is_empty() {
                    "runtime-detector".to_string()
                } else {
                    terminal.detection_source.clone()
                },
                terminal.detection_confidence.max(0.1),
            )
        } else if let Some(configured) = configured_provider {
            (configured, "configured-hint".to_string(), 0.65)
        } else {
            ("terminal-agent".to_string(), "fallback".to_string(), 0.2)
        };
    let mut identity_warnings = terminal.identity_warnings.clone();
    if let (Some(configured), Some(observed)) = (
        terminal.agent_id.as_deref().and_then(normalize_provider),
        observed_provider.as_deref(),
    ) {
        if configured != observed {
            push_warning(
                &mut identity_warnings,
                &format!(
                    "Identity mismatch: configured agent '{}' but observed provider '{}'",
                    configured, observed
                ),
            );
        }
    }
    let identity_needs_confirmation = observed_provider.is_some()
        && detection_source != "completion-event"
        && detection_confidence < 0.75;
    ResolvedIdentity {
        observed_provider,
        resolved_provider,
        detection_source,
        detection_confidence,
        identity_warnings,
        identity_needs_confirmation,
    }
}

fn normalize_observed_provider(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(normalize_provider(value).unwrap_or_else(|| value.to_ascii_lowercase()))
}

fn identity_source_priority(source: &str) -> u8 {
    match source {
        "completion-event" => 5,
        "process-tree" => 4,
        "command-observed" => 3,
        "configured-hint" => 2,
        _ => 1,
    }
}

fn update_identity_from_snapshot(
    record: &mut AgentSessionRecord,
    terminal: &TerminalAgentSnapshot,
    identity: &ResolvedIdentity,
) {
    if record.reference.configured_agent_id.is_none() {
        record.reference.configured_agent_id = terminal.agent_id.clone();
    }
    let current_priority = identity_source_priority(&record.reference.detection_source);
    let incoming_priority = identity_source_priority(&identity.detection_source);
    if incoming_priority >= current_priority
        && (identity.observed_provider.is_some() || record.reference.observed_provider.is_none())
    {
        record.reference.observed_provider = identity.observed_provider.clone();
        record.reference.resolved_provider = identity.resolved_provider.clone();
        record.reference.provider = identity.resolved_provider.clone();
        record.reference.detection_source = identity.detection_source.clone();
        record.reference.detection_confidence = identity.detection_confidence;
        record.reference.identity_needs_confirmation = identity.identity_needs_confirmation;
    }
    for warning in &identity.identity_warnings {
        push_warning(&mut record.reference.identity_warnings, warning);
        push_warning(&mut record.warnings, warning);
    }
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
            observed_provider: None,
            detection_source: "configured-hint".to_string(),
            detection_confidence: 0.65,
            identity_warnings: Vec::new(),
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
    fn observed_completion_provider_overrides_configured_hint_and_records_mismatch() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.agent_id = Some("pi".to_string());
        registry.observe_terminal_started(&terminal, "before");
        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("codex-event".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            None,
            "after",
        ));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(session.configured_agent_id.as_deref(), Some("pi"));
        assert_eq!(session.observed_provider.as_deref(), Some("codex"));
        assert_eq!(session.resolved_provider, "codex");
        assert_eq!(session.detection_source, "completion-event");
        assert!(session
            .identity_warnings
            .iter()
            .any(|warning| warning.contains("configured agent 'pi'")));
        registry.observe_terminal_started(&terminal, "later");
        let session_after_refresh = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(session_after_refresh.resolved_provider, "codex");
    }

    #[test]
    fn generic_terminal_is_promoted_by_runtime_observation() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.is_agent_terminal = false;
        terminal.agent_id = None;
        terminal.observed_provider = Some("freebuff".to_string());
        terminal.detection_source = "command-observed".to_string();
        terminal.detection_confidence = 0.8;
        let reference = registry
            .observe_terminal_started(&terminal, "now")
            .expect("runtime detection promotes a generic terminal");
        assert_eq!(reference.resolved_provider, "freebuff");
        assert_eq!(reference.detection_source, "command-observed");
    }

    #[test]
    fn providers_and_results_stay_isolated_by_terminal_and_generation() {
        let registry = AgentSessionRegistry::default();
        let mut codex = terminal(1, true);
        codex.terminal_id = "codex-terminal".to_string();
        let mut pi = terminal(1, true);
        pi.terminal_id = "pi-terminal".to_string();
        pi.agent_id = Some("pi".to_string());
        registry.observe_terminal_started(&codex, "now");
        registry.observe_terminal_started(&pi, "now");
        assert!(registry.observe_completion(
            &codex,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("codex-1".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            Some(super::super::types::AgentResult {
                content: "codex result".to_string(),
                truncated: false,
                untrusted: true,
                provenance: Provenance::untrusted("test", "now"),
            }),
            "now",
        ));
        assert!(registry.observe_completion(
            &pi,
            CompletionObservation {
                provider: "pi".to_string(),
                event_id: Some("pi-1".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            Some(super::super::types::AgentResult {
                content: "pi result".to_string(),
                truncated: false,
                untrusted: true,
                provenance: Provenance::untrusted("test", "now"),
            }),
            "now",
        ));
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 2);
        for session in sessions {
            let result = registry.last_result(&session).unwrap().unwrap();
            if session.terminal_id.as_deref() == Some("codex-terminal") {
                assert_eq!(result.content, "codex result");
            } else {
                assert_eq!(result.content, "pi result");
            }
        }
    }

    #[test]
    fn pruning_is_bounded_and_keeps_the_current_generation() {
        let registry = AgentSessionRegistry::default();
        for generation in 1..=300 {
            started(&registry, generation);
        }
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert!(sessions.len() <= super::MAX_RETAINED_SESSIONS);
        assert!(sessions.len() <= super::MAX_TERMINAL_HISTORY + 1);
        assert!(sessions.iter().any(|session| session.generation == 300));
    }

    #[test]
    fn completion_dedupe_eviction_accepts_a_new_event_after_the_bound() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        let observation = |event_id: String| CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some(event_id),
            provider_session_id: None,
            provider_turn_id: None,
            occurred_at: None,
        };
        assert!(registry.observe_completion(
            &terminal,
            observation("original".to_string()),
            None,
            "now",
        ));
        for index in 0..super::MAX_COMPLETION_KEYS {
            assert!(registry.observe_completion(
                &terminal,
                observation(format!("event-{index}")),
                None,
                "now",
            ));
        }
        assert!(registry.observe_completion(
            &terminal,
            observation("original".to_string()),
            None,
            "later",
        ));
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
