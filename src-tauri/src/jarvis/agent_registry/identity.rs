//! Agent identity resolution, provenance, and human confirmation decisions.

use super::{
    push_warning, AgentSessionRecord, AgentSessionRegistry, IdentityDecision, IdentityDecisionKey,
    ResolvedIdentity, TerminalAgentSnapshot,
};
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{AgentSessionRef, AgentState, Provenance};

impl AgentSessionRegistry {
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

    /// Confirm the identity of a terminal on behalf of the human user.
    /// Called when the user explicitly confirms an action (send/abort)
    /// targeting a terminal whose identity is still unconfirmed — e.g. a
    /// manually launched agent detected from its launch command
    /// (command-observed, confidence below the 0.75 confirmation gate).
    /// Returns `true` when a matching unconfirmed record was found and
    /// unblocked. A prior `Ignored` decision is not overridden.
    pub fn confirm_identity_for_terminal(&self, terminal_id: &str, generation: u64) -> bool {
        let provider = {
            let Ok(sessions) = self.sessions.lock() else {
                return false;
            };
            let Some(record) = sessions.values().find(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id)
                    && record.reference.generation == generation
                    && record.reference.identity_needs_confirmation
                    && record.state != AgentState::Exited
            }) else {
                return false;
            };
            record
                .reference
                .observed_provider
                .clone()
                .or_else(|| Some(record.reference.resolved_provider.clone()))
        };
        let Some(provider) = provider else {
            return false;
        };
        self.set_identity_decision(
            terminal_id,
            generation,
            &provider,
            IdentityDecision::Confirmed,
        );
        true
    }

    pub fn mark_selected(&self, reference: &AgentSessionRef) {
        if let Ok(mut selected) = self.selected_session.lock() {
            *selected = Some(reference.agent_session_id.clone());
        }
    }

    pub(super) fn identity_decision(
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
}

pub(super) fn identity_from_snapshot(terminal: &TerminalAgentSnapshot) -> ResolvedIdentity {
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

pub(super) fn normalize_observed_provider(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(normalize_provider(value).unwrap_or_else(|| value.to_ascii_lowercase()))
}

pub(crate) fn identity_source_priority(source: &str) -> u8 {
    match source {
        "completion-event" => 5,
        "backend-launch" => 4,
        "process-tree" => 4,
        "command-observed" => 3,
        "configured-hint" => 2,
        _ => 1,
    }
}

pub(super) fn update_identity_from_snapshot(
    record: &mut AgentSessionRecord,
    terminal: &TerminalAgentSnapshot,
    identity: &ResolvedIdentity,
) {
    if terminal.agent_alias.is_some() {
        record.reference.agent_alias = terminal.agent_alias.clone();
    }
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

pub(super) fn registry_provenance(observed_at: &str) -> Provenance {
    Provenance {
        source: "terminal-registry".to_string(),
        observed_at: observed_at.to_string(),
        confidence: 0.75,
        untrusted: true,
    }
}
