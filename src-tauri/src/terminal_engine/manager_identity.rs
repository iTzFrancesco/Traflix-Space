use super::*;

pub(crate) fn snapshot_from_session(session: &TerminalSession) -> TerminalAgentSnapshot {
    TerminalAgentSnapshot {
        terminal_id: session.id.clone(),
        workspace_id: session.workspace_id.clone().unwrap_or_default(),
        is_agent_terminal: session.is_agent_terminal,
        agent_id: session.agent_id.clone(),
        agent_alias: session.agent_alias.clone(),
        observed_provider: session.observed_provider.clone(),
        detection_source: session.detection_source.clone(),
        detection_confidence: session.detection_confidence,
        identity_warnings: session.identity_warnings.clone(),
        generation: session.generation,
        process_id: session.process_id,
        process_alive: session.process_alive.load(Ordering::Acquire),
        agent_process_alive: session.agent_runtime_presence.alive(),
    }
}

pub(crate) fn promote_backend_launch_detection(
    origin: TerminalInputOrigin,
    launch_state: Option<&str>,
    configured_agent: Option<&str>,
    mut detection: AgentDetection,
) -> AgentDetection {
    let backend_launch_in_progress = origin == TerminalInputOrigin::Internal
        && matches!(launch_state, Some("starting" | "ready"));
    let configured_provider = configured_agent.map(|value| value.trim().to_ascii_lowercase());
    if backend_launch_in_progress
        && configured_provider.as_deref() == Some(detection.provider.as_str())
    {
        detection.source = "backend-launch".to_string();
        detection.confidence = 1.0;
    }
    detection
}

pub(crate) fn candidate_descendant_provider(session: &TerminalSession) -> Option<String> {
    session.observed_provider.clone().or_else(|| {
        matches!(
            session.backend_agent_launch_state.as_deref(),
            Some("starting" | "ready")
        )
        .then(|| session.agent_id.as_deref().and_then(normalize_provider))
        .flatten()
    })
}

pub(crate) fn apply_backend_launch_identity(
    session: &mut TerminalSession,
    detection: &AgentDetection,
) {
    apply_runtime_identity_with_presence(session, detection, false);
}

pub(crate) fn apply_runtime_identity(session: &mut TerminalSession, detection: &AgentDetection) {
    apply_runtime_identity_with_presence(session, detection, true);
}

fn apply_runtime_identity_with_presence(
    session: &mut TerminalSession,
    detection: &AgentDetection,
    observe_presence: bool,
) {
    let current_priority = identity_source_priority(&session.detection_source);
    let incoming_priority = identity_source_priority(&detection.source);
    if session.observed_provider.is_some() && incoming_priority < current_priority {
        return;
    }
    session.observed_provider = Some(detection.provider.clone());
    session.detection_source = detection.source.clone();
    session.detection_confidence = detection.confidence;
    session.is_agent_terminal = true;
    if observe_presence {
        session.agent_runtime_presence.observed();
    }
    if let Some(configured) = session.agent_id.as_deref().and_then(normalize_provider) {
        if configured != detection.provider {
            push_identity_warning(
                &mut session.identity_warnings,
                &format!(
                    "Identity mismatch: configured agent '{}' but observed provider '{}'",
                    configured, detection.provider
                ),
            );
        }
    }
}

pub(crate) fn apply_observed_provider(
    session: &mut TerminalSession,
    provider: &str,
    source: &str,
    confidence: f32,
) {
    let current_priority = identity_source_priority(&session.detection_source);
    if session.observed_provider.is_some() && identity_source_priority(source) < current_priority {
        return;
    }
    let normalized = provider.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return;
    }
    session.observed_provider = Some(normalized.clone());
    session.detection_source = source.to_string();
    session.detection_confidence = confidence;
    session.is_agent_terminal = true;
    if let Some(configured) = session.agent_id.as_deref().and_then(normalize_provider) {
        if configured != normalized {
            push_identity_warning(
                &mut session.identity_warnings,
                &format!(
                    "Identity mismatch: configured agent '{}' but observed provider '{}'",
                    configured, normalized
                ),
            );
        }
    }
}

pub(crate) fn bounded_terminal_text(
    text: &str,
    max_bytes: usize,
) -> Result<NormalizedTerminalText, String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_end_matches('\n');
    if normalized.len() <= max_bytes {
        return Ok(NormalizedTerminalText {
            content: normalized.to_string(),
            truncated: false,
        });
    }
    let mut start = normalized.len().saturating_sub(max_bytes);
    while start < normalized.len() && !normalized.is_char_boundary(start) {
        start += 1;
    }
    Ok(NormalizedTerminalText {
        content: normalized[start..].to_string(),
        truncated: true,
    })
}

fn push_identity_warning(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_string());
    }
}
