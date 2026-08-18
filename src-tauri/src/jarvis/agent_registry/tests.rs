use super::super::agent_adapter::{AgentContextSource, LiveAgentContextSource};
use super::super::types::{
    AgentActivityKind, AgentInteractionSource, AgentResult, AgentState, AgentTaskContext,
    Provenance,
};
use super::{
    fallback_result_from_terminal, AgentSessionRegistry, CompletionObservation,
    TerminalAgentSnapshot, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT, MAX_ACTIVITY_TIMELINE,
    MAX_INPUT_BUFFER_BYTES, MAX_TASK_TEXT_BYTES,
};

#[path = "identity_tests.rs"]
mod identity_tests;

fn terminal(generation: u64, alive: bool) -> TerminalAgentSnapshot {
    TerminalAgentSnapshot {
        terminal_id: "terminal-1".to_string(),
        workspace_id: "workspace-a".to_string(),
        is_agent_terminal: true,
        agent_id: Some("codex".to_string()),
        agent_alias: Some("codex-1".to_string()),
        observed_provider: None,
        detection_source: "configured-hint".to_string(),
        detection_confidence: 0.65,
        identity_warnings: Vec::new(),
        generation,
        process_id: Some(100),
        process_alive: alive,
        agent_process_alive: Some(alive),
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
fn backend_owned_launch_is_control_ready_without_human_confirmation() {
    let registry = AgentSessionRegistry::default();
    let mut agent = terminal(1, true);
    agent.observed_provider = Some("codex".to_string());
    agent.detection_source = "backend-launch".to_string();
    agent.detection_confidence = 1.0;
    registry.observe_terminal_started(&agent, "2026-08-12T00:00:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(!session.identity_needs_confirmation);
    assert!(registry.control_allowed("terminal-1", 1));
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
    assert!(registry.observe_completion(&terminal(1, true), observation.clone(), result, "now",));
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
        AgentState::Starting
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
        AgentState::Starting
    );

    registry.reconcile(&[], "third");
    assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
}

// ---- Phase 7: agent session intelligence -----------------------------

#[test]
fn observed_agent_process_without_a_task_is_waiting_not_working() {
    let registry = AgentSessionRegistry::default();
    let mut observed = terminal(1, true);
    observed.observed_provider = Some("codex".to_string());
    observed.detection_source = "process-tree".to_string();
    observed.detection_confidence = 0.95;
    registry.observe_terminal_started(&observed, "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        registry.status(&session).unwrap().state,
        AgentState::Waiting
    );
}

fn task_of(status: &super::AgentRegistryStatus) -> &AgentTaskContext {
    status
        .current_task
        .as_ref()
        .expect("expected a current task")
}

fn commit(registry: &AgentSessionRegistry, terminal: &TerminalAgentSnapshot, text: &str, at: &str) {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(b'\r');
    registry.observe_user_input(terminal, &bytes, at);
}

#[test]
fn user_committed_input_becomes_a_user_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(&registry, &terminal, "fix the bug", "2026-08-07T00:00:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    let task = task_of(&status);
    assert_eq!(task.text, "fix the bug");
    assert_eq!(task.source, AgentInteractionSource::User);
    assert_eq!(task.confidence, 0.65);
    assert!(task.untrusted);
    assert!(task.completed_at.is_none());
    assert_eq!(status.state, AgentState::Working);
    assert!(status.activity_timeline.iter().any(|event| {
        event.kind == AgentActivityKind::PromptSubmitted
            && event.source == AgentInteractionSource::User
            && event.text_excerpt.as_deref() == Some("fix the bug")
    }));
    assert_eq!(
        session.current_task.as_ref().map(|task| task.text.as_str()),
        Some("fix the bug")
    );
}

#[test]
fn jarvis_send_registers_a_trusted_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    started(&registry, 1);
    registry.observe_jarvis_send(&terminal, "refactor the module\n", "2026-08-07T00:00:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    let task = task_of(&status);
    assert_eq!(task.source, AgentInteractionSource::Jarvis);
    assert_eq!(task.confidence, 0.95);
    assert!(!task.untrusted);
    assert_eq!(task.text, "refactor the module\n");
    assert!(status
        .activity_timeline
        .iter()
        .any(|event| event.source == AgentInteractionSource::Jarvis && !event.untrusted));
}

#[test]
fn without_successful_write_or_commit_no_task_is_registered() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    started(&registry, 1);

    registry.observe_user_input(&terminal, b"draft", "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(registry.status(&session).unwrap().current_task.is_none());

    let registry = AgentSessionRegistry::default();
    started(&registry, 1);
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(registry.status(&session).unwrap().current_task.is_none());
}

#[test]
fn backspace_reconstructs_the_committed_line() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    registry.observe_user_input(&terminal, b"fixx\x08 the bug\r", "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        task_of(&registry.status(&session).unwrap()).text,
        "fix the bug"
    );
}

#[test]
fn bracketed_paste_commits_multiline_input() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    registry.observe_user_input(
        &terminal,
        b"\x1b[200~first\nsecond\x1b[201~\r",
        "2026-08-07T00:00:00Z",
    );
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        task_of(&registry.status(&session).unwrap()).text,
        "first\nsecond"
    );
}

#[test]
fn unsupported_cursor_edit_invalidates_the_whole_line_until_enter() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    registry.observe_user_input(&terminal, b"prefix\x1b[Dsuffix\r", "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(registry.status(&session).unwrap().current_task.is_none());

    commit(
        &registry,
        &terminal,
        "clean next task",
        "2026-08-07T00:01:00Z",
    );
    assert_eq!(
        task_of(&registry.status(&session).unwrap()).text,
        "clean next task"
    );
}

#[test]
fn oversized_input_never_commits_a_truncated_suffix() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    let mut bytes = vec![b'x'; MAX_INPUT_BUFFER_BYTES + 64];
    bytes.extend_from_slice(b"suffix\r");
    registry.observe_user_input(&terminal, &bytes, "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(registry.status(&session).unwrap().current_task.is_none());

    commit(
        &registry,
        &terminal,
        "clean after overflow",
        "2026-08-07T00:01:00Z",
    );
    assert_eq!(
        task_of(&registry.status(&session).unwrap()).text,
        "clean after overflow"
    );
}

#[test]
fn ctrl_c_interrupts_without_inventing_a_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    registry.observe_user_input(&terminal, b"half a line\x03", "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    assert!(status.current_task.is_none());
    assert!(status
        .activity_timeline
        .iter()
        .any(|event| event.kind == AgentActivityKind::Interrupted));

    commit(&registry, &terminal, "next task", "2026-08-07T00:01:00Z");
    assert_eq!(
        task_of(&registry.status(&session).unwrap()).text,
        "next task"
    );
}

#[test]
fn model_and_help_are_activity_but_never_replace_the_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(
        &registry,
        &terminal,
        "refactor the core",
        "2026-08-07T00:00:00Z",
    );
    commit(&registry, &terminal, "/model", "2026-08-07T00:01:00Z");
    commit(&registry, &terminal, "/help", "2026-08-07T00:02:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    assert_eq!(task_of(&status).text, "refactor the core");
    let prompts = status
        .activity_timeline
        .iter()
        .filter(|event| event.kind == AgentActivityKind::PromptSubmitted)
        .count();
    assert_eq!(prompts, 3);
}

#[test]
fn clear_and_new_archive_the_previous_agent_epoch_in_the_same_pty() {
    for reset_command in ["/clear", "/new"] {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(
            &registry,
            &terminal,
            "task before reset",
            "2026-08-07T00:00:00Z",
        );
        let previous = registry.list_sessions("workspace-a").unwrap().remove(0);

        commit(&registry, &terminal, reset_command, "2026-08-07T00:01:00Z");

        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 2, "{reset_command}");
        let archived = sessions
            .iter()
            .find(|session| session.agent_session_id == previous.agent_session_id)
            .expect("previous epoch retained");
        assert_eq!(
            registry.status(archived).unwrap().state,
            AgentState::Exited,
            "{reset_command}",
        );
        let current = sessions
            .iter()
            .find(|session| session.agent_session_id != previous.agent_session_id)
            .expect("new epoch created");
        let status = registry.status(current).unwrap();
        assert!(status.current_task.is_none(), "{reset_command}");
        assert_ne!(current.agent_session_id, previous.agent_session_id);
    }
}

#[test]
fn pasted_task_after_session_reset_is_attributed_to_the_new_epoch() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(
        &registry,
        &terminal,
        "task before reset",
        "2026-08-07T00:00:00Z",
    );

    registry.observe_user_input(
        &terminal,
        b"/clear\rnew task after reset\r",
        "2026-08-07T00:01:00Z",
    );

    let current = registry
        .list_sessions("workspace-a")
        .unwrap()
        .into_iter()
        .find(|session| {
            registry
                .status(session)
                .is_ok_and(|status| status.state != AgentState::Exited)
        })
        .expect("current epoch");
    assert_eq!(
        registry
            .status(&current)
            .unwrap()
            .current_task
            .expect("task")
            .text,
        "new task after reset"
    );
}

#[test]
fn local_command_after_completion_preserves_waiting_state() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(&registry, &terminal, "real task", "2026-08-07T00:00:00Z");
    assert!(registry.observe_completion(
        &terminal,
        CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some("local-command-state".to_string()),
            provider_session_id: None,
            provider_turn_id: None,
            occurred_at: None,
        },
        None,
        "2026-08-07T00:01:00Z",
    ));
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        registry.status(&session).unwrap().state,
        AgentState::Waiting
    );

    commit(&registry, &terminal, "/model", "2026-08-07T00:02:00Z");
    let status = registry.status(&session).unwrap();
    assert_eq!(status.state, AgentState::Waiting);
    assert_eq!(task_of(&status).text, "real task");
    assert_eq!(
        task_of(&status).completed_at.as_deref(),
        Some("2026-08-07T00:01:00Z")
    );
}

#[test]
fn agent_launch_command_is_session_startup_not_a_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(&registry, &terminal, "codex", "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert!(registry.status(&session).unwrap().current_task.is_none());
}

#[test]
fn output_never_becomes_a_task_and_is_throttled() {
    let registry = AgentSessionRegistry::default();
    started(&registry, 1);
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);

    registry.observe_output("terminal-1", 1, "2026-08-07T00:00:00Z");
    assert_eq!(
        registry
            .status(&session)
            .unwrap()
            .last_activity_at
            .as_deref(),
        Some("2026-08-07T00:00:00Z")
    );
    assert!(registry.status(&session).unwrap().current_task.is_none());

    registry.observe_output("terminal-1", 1, "2026-08-07T00:00:00.500Z");
    assert_eq!(
        registry
            .status(&session)
            .unwrap()
            .last_activity_at
            .as_deref(),
        Some("2026-08-07T00:00:00Z")
    );
    registry.observe_output("terminal-1", 1, "2026-08-07T00:00:01.100Z");
    assert_eq!(
        registry
            .status(&session)
            .unwrap()
            .last_activity_at
            .as_deref(),
        Some("2026-08-07T00:00:01.100Z")
    );
}

#[test]
fn task_text_and_timeline_are_bounded() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    let long_text = format!("\u{1f600} {}", "x".repeat(3000));
    commit(&registry, &terminal, &long_text, "2026-08-07T00:00:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    let task = task_of(&status);
    assert!(task.text.len() <= MAX_TASK_TEXT_BYTES);

    for index in 0..40 {
        registry.observe_jarvis_send(
            &terminal,
            &format!("prompt {index}"),
            &format!("2026-08-07T00:{:02}:00Z", index),
        );
    }
    let timeline = &registry.status(&session).unwrap().activity_timeline;
    assert!(timeline.len() <= MAX_ACTIVITY_TIMELINE);
}

#[test]
fn generation_and_workspace_isolate_tasks_and_activity() {
    let registry = AgentSessionRegistry::default();
    let first = terminal(1, true);
    commit(
        &registry,
        &first,
        "task in generation 1",
        "2026-08-07T00:00:00Z",
    );

    let mut other = terminal(1, true);
    other.terminal_id = "terminal-2".to_string();
    other.workspace_id = "workspace-b".to_string();
    commit(
        &registry,
        &other,
        "task in workspace b",
        "2026-08-07T00:00:10Z",
    );

    let second_generation = terminal(2, true);
    commit(
        &registry,
        &second_generation,
        "task in generation 2",
        "2026-08-07T00:00:20Z",
    );

    let sessions = registry.list_sessions("workspace-a").unwrap();
    assert_eq!(sessions.len(), 2);
    let first_status = registry.status(&sessions[0]).unwrap();
    let second_status = registry.status(&sessions[1]).unwrap();
    assert_eq!(task_of(&first_status).text, "task in generation 1");
    assert_eq!(task_of(&second_status).text, "task in generation 2");
    assert_eq!(first_status.state, AgentState::Exited);

    let mut forged = sessions[0].clone();
    forged.workspace_id = "workspace-b".to_string();
    assert!(registry.activity(&forged, DEFAULT_ACTIVITY_LIMIT).is_err());

    let workspace_b = registry.list_sessions("workspace-b").unwrap();
    assert_eq!(workspace_b.len(), 1);
    assert_eq!(
        task_of(&registry.status(&workspace_b[0]).unwrap()).text,
        "task in workspace b"
    );
}

#[test]
fn activity_lookup_is_bounded() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    for index in 0..20 {
        registry.observe_jarvis_send(
            &terminal,
            &format!("prompt {index}"),
            &format!("2026-08-07T00:{:02}:00Z", index),
        );
    }
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(
        registry.activity(&session, 100).unwrap().len(),
        MAX_ACTIVITY_LIMIT
    );
    assert_eq!(registry.activity(&session, 0).unwrap().len(), 1);
    assert_eq!(registry.activity(&session, 2).unwrap().len(), 2);
}

#[test]
fn completion_marks_the_task_completed_but_keeps_the_session_open() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(&registry, &terminal, "fix the bug", "2026-08-07T00:00:00Z");
    assert!(registry.observe_completion(
        &terminal,
        CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some("event-done".to_string()),
            provider_session_id: None,
            provider_turn_id: None,
            occurred_at: None,
        },
        Some(AgentResult {
            content: "done".to_string(),
            truncated: false,
            untrusted: true,
            provenance: Provenance::untrusted("terminal-fallback", "now"),
        }),
        "2026-08-07T00:01:00Z",
    ));

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    assert_eq!(status.state, AgentState::Waiting);
    assert_eq!(
        task_of(&status).completed_at.as_deref(),
        Some("2026-08-07T00:01:00Z")
    );
    assert!(status
        .activity_timeline
        .iter()
        .any(|event| event.kind == AgentActivityKind::CompletionObserved));
    assert!(status
        .activity_timeline
        .iter()
        .any(|event| event.kind == AgentActivityKind::ResultAvailable));
    assert_eq!(
        registry.last_result(&session).unwrap().unwrap().content,
        "done"
    );

    commit(&registry, &terminal, "second task", "2026-08-07T00:02:00Z");
    assert!(registry
        .status(&session)
        .unwrap()
        .current_task
        .as_ref()
        .unwrap()
        .completed_at
        .is_none());
}

#[test]
fn abort_records_jarvis_interruption_without_completing_the_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(
        &registry,
        &terminal,
        "long running task",
        "2026-08-07T00:00:00Z",
    );
    registry.observe_abort(&terminal, "2026-08-07T00:01:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    let task = task_of(&status);
    assert!(task.completed_at.is_none());
    assert!(status.activity_timeline.iter().any(|event| {
        event.kind == AgentActivityKind::Interrupted
            && event.source == AgentInteractionSource::Jarvis
            && !event.untrusted
    }));
    assert_eq!(
        status.last_activity_at.as_deref(),
        Some("2026-08-07T00:01:00Z")
    );
}

#[test]
fn session_exit_adds_an_exited_activity_without_touching_the_task() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    commit(&registry, &terminal, "final task", "2026-08-07T00:00:00Z");
    registry.observe_terminal_exit("terminal-1", 1, "2026-08-07T00:01:00Z");

    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    let status = registry.status(&session).unwrap();
    assert_eq!(status.state, AgentState::Exited);
    assert!(status
        .activity_timeline
        .iter()
        .any(|event| event.kind == AgentActivityKind::Exited));
    assert!(task_of(&status).completed_at.is_none());
}

#[test]
fn session_exit_clears_stale_identity_confirmation() {
    let registry = AgentSessionRegistry::default();
    let mut terminal = terminal(1, true);
    terminal.observed_provider = Some("pi".to_string());
    terminal.agent_id = Some("pi".to_string());
    terminal.detection_source = "command-observed".to_string();
    terminal.detection_confidence = 0.7;
    registry.observe_terminal_started(&terminal, "2026-08-12T00:00:00Z");
    assert!(
        registry
            .list_sessions("workspace-a")
            .unwrap()
            .remove(0)
            .identity_needs_confirmation
    );

    registry.observe_terminal_exit("terminal-1", 1, "2026-08-12T00:01:00Z");
    let session = registry.list_sessions("workspace-a").unwrap().remove(0);
    assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
    assert!(!session.identity_needs_confirmation);
}

#[test]
fn reset_and_reconcile_exit_paths_clear_identity_confirmation() {
    let registry = AgentSessionRegistry::default();
    let mut terminal = terminal(1, true);
    terminal.agent_id = Some("pi".to_string());
    terminal.observed_provider = Some("pi".to_string());
    terminal.detection_source = "command-observed".to_string();
    terminal.detection_confidence = 0.7;
    registry.observe_terminal_started(&terminal, "2026-08-12T00:00:00Z");
    registry.observe_user_input(&terminal, b"/clear\r", "2026-08-12T00:00:01Z");
    let sessions = registry.list_sessions("workspace-a").unwrap();
    assert!(sessions.iter().all(|session| {
        !session.identity_needs_confirmation
            || registry.status(session).unwrap().state != AgentState::Exited
    }));

    let mut missing_terminal = terminal.clone();
    missing_terminal.is_agent_terminal = false;
    missing_terminal.observed_provider = None;
    registry.reconcile(&[missing_terminal], "2026-08-12T00:00:02Z");
    let sessions = registry.list_sessions("workspace-a").unwrap();
    assert!(sessions.iter().all(|session| {
        registry.status(session).unwrap().state != AgentState::Exited
            || !session.identity_needs_confirmation
    }));
}

#[test]
fn relaunch_after_agent_child_exit_creates_a_new_epoch_without_reopening_the_pty() {
    let registry = AgentSessionRegistry::default();
    let terminal = terminal(1, true);
    registry.observe_terminal_started(&terminal, "2026-08-07T00:00:00Z");
    let first = registry.list_sessions("workspace-a").unwrap().remove(0);
    registry.observe_terminal_exit("terminal-1", 1, "2026-08-07T00:01:00Z");

    registry.observe_terminal_started(&terminal, "2026-08-07T00:02:00Z");
    let sessions = registry.list_sessions("workspace-a").unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(sessions
        .iter()
        .any(|session| session.agent_session_id == first.agent_session_id));
    assert!(sessions
        .iter()
        .any(|session| session.agent_session_id != first.agent_session_id));
}
