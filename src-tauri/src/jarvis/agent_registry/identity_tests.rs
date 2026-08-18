use super::super::super::types::{AgentActivityKind, AgentState};
use super::super::{AgentSessionRegistry, IdentityDecision};
use super::terminal;

// -- idle completion detector --

#[test]
fn output_silence_never_claims_that_a_working_turn_completed() {
    let registry = AgentSessionRegistry::default();
    registry.observe_jarvis_send(
        &terminal(1, true),
        "refactor the module
",
        "2026-08-11T00:00:00Z",
    );
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        registry.status(&session).unwrap().state,
        AgentState::Working
    );

    // Reasoning can be silent for much longer than ten seconds. Only a
    // provider completion notification may settle the turn.
    let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:11Z");
    assert!(settled.is_empty());
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    assert_eq!(status.state, AgentState::Working);
    assert!(!status
        .activity_timeline
        .iter()
        .any(|event| event.kind == AgentActivityKind::CompletionObserved));
}

#[test]
fn active_working_session_is_not_settled_while_output_continues() {
    let registry = AgentSessionRegistry::default();
    registry.observe_jarvis_send(
        &terminal(1, true),
        "start task
",
        "2026-08-11T00:00:00Z",
    );
    registry.observe_output("terminal-1", 1, "2026-08-11T00:00:09Z");
    let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:15Z");
    assert!(settled.is_empty());
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        registry.status(&session).unwrap().state,
        AgentState::Working
    );
}

#[test]
fn session_without_observed_output_is_left_untouched() {
    let registry = AgentSessionRegistry::default();
    let mut agent = terminal(1, true);
    agent.agent_id = Some("pi".to_string());
    agent.observed_provider = Some("pi".to_string());
    agent.detection_source = "command-observed".to_string();
    agent.detection_confidence = 0.7;
    registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
    // No output ever observed (last_activity_at is None): not settled.
    let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:30Z");
    assert!(settled.is_empty());
}

// -- identity confirmation (human action confirms manual agent) --

#[test]
fn confirm_identity_unblocks_manual_agent_detected_from_command() {
    let registry = AgentSessionRegistry::default();
    // Manual agent (pi) detected from its launch command: observed
    // provider, command-observed source, confidence 0.7 < 0.75 gate.
    let mut agent = terminal(1, true);
    agent.agent_id = Some("pi".to_string());
    agent.observed_provider = Some("pi".to_string());
    agent.detection_source = "command-observed".to_string();
    agent.detection_confidence = 0.7;
    registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(session.identity_needs_confirmation);
    assert!(!registry.control_allowed("terminal-1", 1));

    // The human confirmation of the action doubles as the identity
    // confirmation: control is granted without any extra UI step.
    assert!(registry.confirm_identity_for_terminal("terminal-1", 1));
    assert!(registry.control_allowed("terminal-1", 1));

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(!session.identity_needs_confirmation);
}

#[test]
fn confirm_identity_is_a_noop_for_already_confirmed_or_ignored_agents() {
    let registry = AgentSessionRegistry::default();
    // Codex runtime: process-tree detection, above the gate.
    let agent = terminal(1, true);
    registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
    assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));

    // Ignored decision is never overridden by the action path.
    let mut manual = terminal(1, true);
    manual.agent_id = Some("pi".to_string());
    manual.observed_provider = Some("pi".to_string());
    manual.detection_source = "command-observed".to_string();
    manual.detection_confidence = 0.7;
    registry.observe_terminal_started(&manual, "2026-08-11T00:00:01Z");
    registry.set_identity_decision("terminal-1", 1, "pi", IdentityDecision::Ignored);
    assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));
    assert!(!registry.control_allowed("terminal-1", 1));
}

#[test]
fn confirm_identity_does_not_unblock_exited_sessions() {
    let registry = AgentSessionRegistry::default();
    let mut agent = terminal(1, false);
    agent.agent_id = Some("pi".to_string());
    agent.observed_provider = Some("pi".to_string());
    agent.detection_source = "command-observed".to_string();
    agent.detection_confidence = 0.7;
    registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
    assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));
    assert!(!registry.control_allowed("terminal-1", 1));
}
