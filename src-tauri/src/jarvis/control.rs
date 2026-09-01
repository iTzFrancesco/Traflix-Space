//! Conversational control is the seam between the model's semantic plan and
//! Traflix's real, visible PTYs. The model can propose only the typed values
//! in this module; this module owns target resolution, workspace validation,
//! bounded context, readiness and side effects.

use crate::agent::registry::AgentDefinition;
use crate::jarvis::types::{
    AgentAssignmentBinding, AgentSessionContext, AgentState, AgentTail, InvocationBinding,
    Provenance, TerminalSummary,
};
use crate::terminal_engine::{TerminalAgentSnapshot, TerminalRuntimeIdentity};
use crate::workspace::registry::{TerminalConfig, WorkspaceConfig};
use chrono::Utc;
use serde::Serialize;
use tauri::AppHandle;

mod dispatch;
mod execution;
mod lifecycle;
mod plan;
mod reactivation;
mod routing;
mod support;

pub use execution::execute_plan;
pub(crate) use plan::conversational_plan_schema;
use plan::normalize_plan_provider;
use plan::PENDING_CONVERSATION_TTL;
pub use plan::{
    ConversationStep, ConversationalControlState, ConversationalPlan, PendingConversationKind,
    PendingConversationalIntent, PlanOperation,
};
pub use routing::build_tail;

pub const MAX_HANDOFF_CONTEXT_BYTES: usize = 6 * 1024;
pub const DEFAULT_TAIL_LINES: usize = 40;
pub const MAX_TAIL_LINES: usize = 100;
pub const MAX_TAIL_BYTES: usize = 12 * 1024;

const DISPATCH_PTY_WRITE_ACCEPTED: &str = "pty_write_accepted";
const DISPATCH_PROMPT_SUBMITTED: &str = "prompt_submitted";
/// Reserved terminal state for a future provider/session-start observation.
/// Current PTY-only dispatches must remain `submission_unconfirmed`.
#[allow(dead_code)]
const DISPATCH_TURN_STARTED: &str = "turn_started";
const DISPATCH_SUBMISSION_UNCONFIRMED: &str = "submission_unconfirmed";
const DISPATCH_TURN_FAILED: &str = "turn_failed";

fn unconfirmed_dispatch_stages() -> Vec<&'static str> {
    vec![
        DISPATCH_PTY_WRITE_ACCEPTED,
        DISPATCH_PROMPT_SUBMITTED,
        DISPATCH_SUBMISSION_UNCONFIRMED,
    ]
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenedEvent {
    pub workspace_id: String,
    pub terminal: TerminalConfig,
    pub generation: u64,
    pub process_id: Option<u32>,
    pub launch_state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClosedEvent {
    pub workspace_id: String,
    pub terminal_id: String,
    pub generation: u64,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TargetResolution {
    Selected(ResolvedAgentTarget),
    Ambiguous(Vec<String>),
    NotFound,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAgentTarget {
    pub terminal: TerminalSummary,
    pub session: AgentSessionContext,
}

#[derive(Debug, Clone)]
pub struct ControlExecution {
    pub response: String,
    pub warnings: Vec<String>,
    pub steps: Vec<StepExecutionReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepExecutionReceipt {
    pub operation: PlanOperation,
    pub status: &'static str,
    pub target: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<AgentRecipientReceipt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecipientReceipt {
    pub assignment_id: String,
    pub agent_alias: String,
    pub agent_session_id: String,
    pub terminal_id: String,
    pub generation: u64,
    pub process_id: Option<u32>,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub display_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenResult {
    pub provider: String,
    pub terminal_id: String,
    pub generation: u64,
    pub initial_prompt_sent: bool,
    pub agent_alias: String,
    pub agent_session_id: String,
    pub assignment_id: Option<String>,
    pub dispatch_status: Option<&'static str>,
    pub dispatch_stages: Vec<&'static str>,
}

/// Typed command seam for callers that already have an explicit provider.
/// The conversational planner uses the same implementation after its own
/// semantic interpretation; no caller can inject a shell command here.
pub async fn open_agent_for_invocation(
    app: &AppHandle,
    workspace: &WorkspaceConfig,
    invocation: &InvocationBinding,
    provider: &str,
    initial_prompt: Option<String>,
) -> Result<AgentOpenResult, String> {
    let opened =
        lifecycle::open_agent(app, workspace, invocation, provider, initial_prompt).await?;
    let lifecycle::OpenResult::Opened {
        provider,
        sent,
        terminal_id,
        generation,
        agent_alias,
        agent_session_id,
        dispatch,
    } = opened;
    Ok(AgentOpenResult {
        provider,
        terminal_id,
        generation,
        initial_prompt_sent: sent,
        agent_alias,
        agent_session_id,
        assignment_id: dispatch
            .as_ref()
            .map(|item| item.binding.assignment_id.clone()),
        dispatch_status: dispatch.as_ref().map(|item| item.status),
        dispatch_stages: dispatch.map(|item| item.stages).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::execution::{
        operations_for_execution, should_parallelize_agent_sends, validate_agent_dispatches,
    };
    use super::lifecycle::{
        allocate_agent_alias, automatic_agent_title, readiness_evidence, startup_failure_code,
        validate_readiness_runtime, ReadinessEvidence,
    };
    use super::plan::{normalize_plan_provider, validate_plan_text};
    use super::routing::{
        automatic_follow_up_requested, batch_confirmation_matches, binding_matches_target,
        bound_target_from_pending, merge_step_with_pending, provider_hint_from_query,
        score_candidate, target_from_binding,
    };
    use super::support::{synthetic_session, terminal_summary_for_config};
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn plan_provider_alias_maps_p_to_pi() {
        assert_eq!(normalize_plan_provider("p"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("P"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("pi"), Some("pi".to_string()));
        assert_eq!(normalize_plan_provider("codex"), Some("codex".to_string()));
        assert_eq!(
            normalize_plan_provider("opencode"),
            Some("opencode".to_string())
        );
        assert_eq!(
            normalize_plan_provider(" agente P "),
            Some("pi".to_string())
        );
        assert_eq!(
            normalize_plan_provider("claude"),
            Some("claude".to_string())
        );
        assert_eq!(
            normalize_plan_provider("claudex"),
            Some("claudex".to_string())
        );
        assert_eq!(normalize_plan_provider("Cloud"), Some("claude".to_string()));
        assert_eq!(
            normalize_plan_provider("CloudX"),
            Some("claudex".to_string())
        );
        assert_eq!(normalize_plan_provider("openai"), None);
    }

    #[test]
    fn provider_hint_extracts_the_stable_provider_from_display_labels() {
        assert_eq!(
            provider_hint_from_query("subagent 1 - antigravity"),
            Some("anti-gravity".to_string())
        );
        assert_eq!(
            provider_hint_from_query("subagent 2 - grok"),
            Some("grok".to_string())
        );
        assert_eq!(provider_hint_from_query("subagent 3"), None);
    }

    #[test]
    fn plan_validation_accepts_p_alias_provider() {
        let plan = ConversationalPlan {
            response: None,
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentOpen,
                provider: Some("p".to_string()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("fai una task".to_string()),
                confirmed: false,
                allow_busy: false,
                follow_up: false,
            }],
        };
        assert!(plan.validate().is_ok());
    }

    #[test]
    fn multi_agent_dispatch_rejects_a_step_without_an_explicit_target() {
        let operations = vec![
            ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("pi".into()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("controlla il frontend".into()),
                confirmed: false,
                allow_busy: false,
                follow_up: false,
            },
            ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: None,
                target: None,
                source: None,
                destination: None,
                prompt: Some("controlla i test".into()),
                confirmed: false,
                allow_busy: false,
                follow_up: false,
            },
        ];
        assert!(validate_agent_dispatches(&operations).is_err());
    }

    #[test]
    fn independent_agent_sends_are_the_only_plan_shape_parallelized() {
        let send = |provider: &str| ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some(provider.into()),
            target: None,
            source: None,
            destination: None,
            prompt: Some(format!("task for {provider}")),
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        assert!(should_parallelize_agent_sends(&[send("codex"), send("pi")]));
        let mut dependent = send("pi");
        dependent.operation = PlanOperation::AgentHandoff;
        assert!(!should_parallelize_agent_sends(&[send("codex"), dependent]));
    }

    #[test]
    fn resuming_pending_work_keeps_the_unexecuted_tail() {
        let pending_first = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some("pi".into()),
            target: Some("PI".into()),
            source: None,
            destination: None,
            prompt: Some("review frontend".into()),
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let pending_tail = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: Some("codex".into()),
            target: Some("Codex".into()),
            source: None,
            destination: None,
            prompt: Some("review backend".into()),
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "w".into(),
            kind: PendingConversationKind::Clarification,
            question: "aggiungo il task?".into(),
            operation: PlanOperation::AgentSend,
            terminal_id: Some("pi-terminal".into()),
            generation: Some(1),
            binding: None,
            created_at: "2026-08-07T00:00:00Z".into(),
            expires_at: "2999-08-07T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![pending_first, pending_tail.clone()],
                response: None,
            },
        };
        let answer = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: true,
            follow_up: false,
        };
        let (operations, resumes) = operations_for_execution(
            &ConversationalPlan {
                operations: vec![answer],
                response: None,
            },
            Some(&pending),
        );
        assert!(resumes);
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[1], pending_tail);
    }

    fn readiness_definition() -> AgentDefinition {
        AgentDefinition {
            id: "codex".into(),
            name: "Codex".into(),
            description: String::new(),
            command: "codex".into(),
            args: Vec::new(),
            env: HashMap::new(),
            icon: String::new(),
            color: String::new(),
            readiness_hints: vec!["shortcuts".into(), "openai".into()],
        }
    }

    fn readiness_snapshot(source: &str, provider: Option<&str>) -> TerminalAgentSnapshot {
        TerminalAgentSnapshot {
            terminal_id: "terminal-a".into(),
            workspace_id: "workspace-a".into(),
            is_agent_terminal: true,
            agent_id: Some("codex".into()),
            agent_alias: Some("codex-1".into()),
            observed_provider: provider.map(str::to_string),
            detection_source: source.into(),
            detection_confidence: if source == "process-tree" { 0.95 } else { 0.7 },
            identity_warnings: Vec::new(),
            generation: 7,
            process_id: Some(42),
            process_alive: true,
            agent_process_alive: Some(true),
        }
    }

    fn sample_terminal(generation: u64) -> TerminalSummary {
        TerminalSummary {
            terminal_id: "t".into(),
            workspace_id: "w".into(),
            title: "Codex Auth".into(),
            agent_alias: Some("codex-1".into()),
            shell: "shell".into(),
            cwd: ".".into(),
            active: false,
            process_id: Some(42),
            process_alive: true,
            agent_id: Some("codex".into()),
            configured_agent_id: Some("codex".into()),
            observed_provider: Some("codex".into()),
            resolved_provider: "codex".into(),
            detection_source: "test".into(),
            detection_confidence: 1.0,
            identity_warnings: Vec::new(),
            generation,
            provenance: Provenance::trusted("test", "now"),
        }
    }

    #[test]
    fn readiness_accepts_process_identity_without_tui_wording() {
        let definition = readiness_definition();
        let snapshot = readiness_snapshot("process-tree", Some("codex"));
        assert_eq!(
            readiness_evidence(&snapshot, &definition, "completely new tui"),
            Some(ReadinessEvidence::ProcessTree),
        );

        let wrong_provider = readiness_snapshot("process-tree", Some("claude"));
        assert_eq!(
            readiness_evidence(&wrong_provider, &definition, "completely new tui"),
            None,
        );
    }

    #[test]
    fn readiness_hints_remain_a_bounded_fallback_and_startup_errors_are_explicit() {
        let definition = readiness_definition();
        let snapshot = readiness_snapshot("command-observed", Some("codex"));
        assert_eq!(
            readiness_evidence(&snapshot, &definition, "type /shortcuts for help"),
            Some(ReadinessEvidence::TerminalHint),
        );
        assert_eq!(
            startup_failure_code("categoryinfo: commandnotfoundexception"),
            Some("command-not-found"),
        );
        assert_eq!(
            startup_failure_code("error: cannot find module cli.js"),
            Some("runtime-module-missing"),
        );
    }

    #[test]
    fn readiness_validates_the_complete_runtime_identity() {
        let snapshot = readiness_snapshot("process-tree", Some("codex"));
        let runtime = TerminalRuntimeIdentity {
            workspace_id: "workspace-a".into(),
            generation: 7,
            process_id: Some(42),
            agent_launch_owner: Some("backend".into()),
            agent_launch_state: Some("starting".into()),
        };
        assert!(validate_readiness_runtime(&snapshot, &runtime).is_ok());

        let mut stale = runtime;
        stale.process_id = Some(43);
        assert_eq!(
            validate_readiness_runtime(&snapshot, &stale).unwrap_err(),
            "sessione agente sostituita durante l'avvio",
        );
    }

    #[test]
    fn plan_rejects_unknown_provider_and_arbitrary_control_bytes() {
        let invalid = ConversationalPlan {
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("unknown".into()),
                target: None,
                source: None,
                destination: None,
                prompt: Some("x".into()),
                confirmed: false,
                allow_busy: false,
                follow_up: false,
            }],
            response: None,
        };
        assert!(invalid.validate().is_err());
        assert!(validate_plan_text("\0").is_err());
    }

    #[test]
    fn continuation_send_may_defer_prompt_validation_until_pending_merge() {
        let continuation = ConversationalPlan {
            operations: vec![ConversationStep {
                operation: PlanOperation::AgentSend,
                provider: Some("codex".into()),
                target: None,
                source: None,
                destination: None,
                prompt: None,
                confirmed: false,
                allow_busy: true,
                follow_up: false,
            }],
            response: None,
        };
        assert!(continuation.validate().is_ok());
    }

    #[test]
    fn handoff_to_new_agent_preserves_source_and_instruction() {
        let previous = ConversationStep {
            operation: PlanOperation::AgentHandoff,
            provider: Some("opencode".into()),
            target: None,
            source: Some("Codex Auth".into()),
            destination: Some("OpenCode Review".into()),
            prompt: Some("controlla soprattutto i test".into()),
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "w".into(),
            kind: PendingConversationKind::Clarification,
            question: "aprirne uno nuovo?".into(),
            operation: PlanOperation::AgentHandoff,
            terminal_id: Some("busy".into()),
            generation: Some(1),
            binding: None,
            created_at: "2026-08-07T00:00:00Z".into(),
            expires_at: "2999-08-07T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![previous],
                response: None,
            },
        };
        let next = ConversationStep {
            operation: PlanOperation::AgentOpen,
            provider: Some("pi".into()),
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let merged = merge_step_with_pending(&next, Some(&pending));
        assert_eq!(merged.source.as_deref(), Some("Codex Auth"));
        assert_eq!(
            merged.prompt.as_deref(),
            Some("controlla soprattutto i test")
        );
        assert_eq!(merged.provider.as_deref(), Some("pi"));
    }

    #[test]
    fn tail_is_bounded_by_lines_and_bytes_and_untrusted() {
        let tail = build_tail("w", "t", 4, "a\nb\nc\nd", 2, false);
        assert_eq!(tail.content, "c\nd");
        assert!(tail.truncated);
        assert!(tail.provenance.untrusted);
    }

    #[test]
    fn candidate_resolution_score_uses_read_only_title_and_prefers_waiting() {
        let terminal = sample_terminal(1);
        let mut working = synthetic_session(
            &TerminalConfig {
                id: "t".into(),
                shell: "shell".into(),
                agent_id: Some("codex".into()),
                command: None,
                cwd: ".".into(),
                title: "Codex Auth".into(),
                agent_alias: None,
                title_manual: true,
                workspace_id: Some("w".into()),
            },
            1,
        );
        working.state = AgentState::Working;
        let mut waiting = working.clone();
        waiting.state = AgentState::Waiting;
        assert!(score_candidate("auth", &working, &terminal, None) > 0);
        assert!(
            score_candidate("auth", &waiting, &terminal, None)
                > score_candidate("auth", &working, &terminal, None)
        );
    }

    fn routing_fixture_context(generation: u64) -> crate::jarvis::types::ModelContextViewV1 {
        use crate::jarvis::types::{DocumentationSummary, RequestedDepth};
        let mut terminals = Vec::new();
        let mut agent_sessions = Vec::new();
        for (index, alias) in ["codex-1", "codex-2", "codex-3"].into_iter().enumerate() {
            let id = format!("terminal-{}", index + 1);
            let config = TerminalConfig {
                id: id.clone(),
                shell: "powershell.exe".into(),
                agent_id: Some("codex".into()),
                command: None,
                cwd: "C:\\repo".into(),
                title: "Codex — Traflix-Space".into(),
                agent_alias: Some(alias.into()),
                title_manual: false,
                workspace_id: Some("workspace-a".into()),
            };
            let mut terminal = terminal_summary_for_config(&config, generation);
            terminal.process_id = Some(100 + index as u32);
            let mut session = synthetic_session(&config, generation);
            session.reference.agent_session_id = format!("session-{alias}");
            session.reference.agent_alias = Some(alias.into());
            session.reference.terminal_id = Some(id);
            terminals.push(terminal);
            agent_sessions.push(session);
        }
        crate::jarvis::types::ModelContextViewV1 {
            view_version: "test".into(),
            invocation: InvocationBinding::new(
                "request-test",
                "workspace-a",
                None,
                None,
                "2026-08-12T00:00:00Z",
            ),
            documentation_summary: DocumentationSummary {
                workspace_id: "workspace-a".into(),
                revision: "test".into(),
                cache_status: crate::jarvis::types::CacheStatus::Hit,
                document_count: 0,
                omitted_count: 0,
                truncated_count: 0,
                warning_count: 0,
            },
            document_index: Vec::new(),
            documentation_excerpts: Vec::new(),
            terminals,
            agent_sessions,
            requested_depth: RequestedDepth::Summary,
            provenance: Provenance::trusted("test", "now"),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn equal_display_titles_select_only_the_stable_alias_binding() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:2".into(),
            agent_alias: "codex-2".into(),
            agent_session_id: "session-codex-2".into(),
            terminal_id: "terminal-2".into(),
            generation: 7,
            process_id: Some(101),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let target = target_from_binding(&context, &binding).expect("exact alias binding");
        assert_eq!(target.terminal.title, "Codex — Traflix-Space");
        assert_eq!(target.terminal.terminal_id, "terminal-2");
        assert_eq!(
            target.session.reference.agent_alias.as_deref(),
            Some("codex-2")
        );

        for (alias, terminal_id) in [("codex-1", "terminal-1"), ("codex-3", "terminal-3")] {
            let binding = AgentAssignmentBinding {
                assignment_id: format!("assignment:test:{alias}"),
                agent_alias: alias.into(),
                agent_session_id: format!("session-{alias}"),
                terminal_id: terminal_id.into(),
                generation: 7,
                process_id: Some(if alias == "codex-1" { 100 } else { 102 }),
                provider: "codex".into(),
                provider_session_id: None,
            };
            let target = target_from_binding(&context, &binding).expect("exact alias binding");
            assert_eq!(target.terminal.terminal_id, terminal_id);
            assert_eq!(target.session.reference.agent_alias.as_deref(), Some(alias));
        }
    }

    #[test]
    fn generation_change_rejects_follow_up_without_fallback() {
        let context = routing_fixture_context(8);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: None,
        };
        assert_eq!(
            target_from_binding(&context, &binding).unwrap_err(),
            "agent_binding_stale_or_mismatch"
        );
    }

    #[test]
    fn binding_identity_mismatches_reject_session_terminal_and_process_changes() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let target = target_from_binding(&context, &binding).expect("valid binding");

        let mut session_mismatch = binding.clone();
        session_mismatch.agent_session_id = "session-codex-other".into();
        assert!(!binding_matches_target(&session_mismatch, &target));

        let mut terminal_mismatch = binding.clone();
        terminal_mismatch.terminal_id = "terminal-other".into();
        assert!(!binding_matches_target(&terminal_mismatch, &target));

        let mut process_mismatch = binding;
        process_mismatch.process_id = Some(999);
        assert!(!binding_matches_target(&process_mismatch, &target));

        let mut provider_mismatch = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "claude".into(),
            provider_session_id: None,
        };
        assert!(!binding_matches_target(&provider_mismatch, &target));
        provider_mismatch.provider = "codex".into();
        assert!(binding_matches_target(&provider_mismatch, &target));
    }

    #[test]
    fn batch_close_confirmation_matches_each_exact_target() {
        let context = routing_fixture_context(7);
        let first = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let second = AgentAssignmentBinding {
            assignment_id: "assignment:test:2".into(),
            agent_alias: "codex-2".into(),
            agent_session_id: "session-codex-2".into(),
            terminal_id: "terminal-2".into(),
            generation: 7,
            process_id: Some(101),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let target = target_from_binding(&context, &second).expect("second target");
        let step = ConversationStep {
            operation: PlanOperation::TerminalClose,
            provider: None,
            target: Some("codex-2".into()),
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let bindings = vec![first, second.clone()];
        assert!(batch_confirmation_matches(Some(&bindings), &step, &target));

        let mut stale = second;
        stale.generation = 8;
        assert!(!batch_confirmation_matches(Some(&[stale]), &step, &target));
    }

    #[test]
    fn follow_up_uses_the_pending_binding_with_duplicate_titles() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:2".into(),
            agent_alias: "codex-2".into(),
            agent_session_id: "session-codex-2".into(),
            terminal_id: "terminal-2".into(),
            generation: 7,
            process_id: Some(101),
            provider: "codex".into(),
            provider_session_id: None,
        };
        let pending = PendingConversationalIntent {
            workspace_id: "workspace-a".into(),
            kind: PendingConversationKind::Clarification,
            question: "continua?".into(),
            operation: PlanOperation::AgentSend,
            terminal_id: Some("terminal-2".into()),
            generation: Some(7),
            binding: Some(binding),
            created_at: "2026-08-12T00:00:00Z".into(),
            expires_at: "2999-08-12T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: vec![ConversationStep {
                    operation: PlanOperation::AgentSend,
                    provider: None,
                    target: None,
                    source: None,
                    destination: None,
                    prompt: Some("continua il lavoro".into()),
                    confirmed: false,
                    allow_busy: false,
                    follow_up: false,
                }],
                response: None,
            },
        };
        let incoming = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        let merged = merge_step_with_pending(&incoming, Some(&pending));
        let target = bound_target_from_pending(&context, Some(&pending), &merged, &incoming)
            .expect("pending binding is valid")
            .expect("follow-up must use the pending binding");
        assert_eq!(target.terminal.terminal_id, "terminal-2");
        assert_eq!(
            target.session.reference.agent_alias.as_deref(),
            Some("codex-2")
        );
    }

    #[test]
    fn follow_up_intent_skips_busy_confirmation_only_for_a_bound_assignment() {
        let pending = PendingConversationalIntent {
            workspace_id: "workspace-a".into(),
            kind: PendingConversationKind::Clarification,
            question: "aggiungo il follow-up?".into(),
            operation: PlanOperation::AgentSend,
            terminal_id: Some("terminal-2".into()),
            generation: Some(7),
            binding: Some(AgentAssignmentBinding {
                assignment_id: "assignment:test:2".into(),
                agent_alias: "codex-2".into(),
                agent_session_id: "session-codex-2".into(),
                terminal_id: "terminal-2".into(),
                generation: 7,
                process_id: Some(101),
                provider: "codex".into(),
                provider_session_id: None,
            }),
            created_at: "2026-08-12T00:00:00Z".into(),
            expires_at: "2999-08-12T00:00:00Z".into(),
            plan: ConversationalPlan {
                operations: Vec::new(),
                response: None,
            },
        };
        let answer = ConversationStep {
            operation: PlanOperation::AgentSend,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: None,
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        };
        assert!(automatic_follow_up_requested(
            Some(&pending),
            &answer,
            &answer,
        ));

        let fresh_follow_up = ConversationStep {
            follow_up: true,
            ..answer.clone()
        };
        assert!(automatic_follow_up_requested(
            None,
            &fresh_follow_up,
            &fresh_follow_up,
        ));
        assert!(!automatic_follow_up_requested(None, &answer, &answer));

        let decoded: ConversationalPlan = serde_json::from_value(serde_json::json!({
            "operations": [{
                "operation": "agent_send",
                "target": "codex-2",
                "prompt": "controlla il risultato",
                "followUp": true
            }]
        }))
        .expect("followUp is part of the typed plan contract");
        assert!(decoded.operations[0].follow_up);
    }

    #[test]
    fn provider_session_change_rejects_binding_without_title_fallback() {
        let context = routing_fixture_context(7);
        let binding = AgentAssignmentBinding {
            assignment_id: "assignment:test:1".into(),
            agent_alias: "codex-1".into(),
            agent_session_id: "session-codex-1".into(),
            terminal_id: "terminal-1".into(),
            generation: 7,
            process_id: Some(100),
            provider: "codex".into(),
            provider_session_id: Some("provider-session-before-restart".into()),
        };
        assert_eq!(
            target_from_binding(&context, &binding).unwrap_err(),
            "agent_binding_stale_or_mismatch"
        );
    }

    #[test]
    fn successful_pty_write_without_observable_turn_is_unconfirmed() {
        assert_eq!(DISPATCH_TURN_STARTED, "turn_started");
        assert_eq!(
            unconfirmed_dispatch_stages(),
            vec![
                "pty_write_accepted",
                "prompt_submitted",
                "submission_unconfirmed"
            ]
        );
        assert_ne!(DISPATCH_SUBMISSION_UNCONFIRMED, DISPATCH_TURN_STARTED);
    }

    #[test]
    fn dispatch_lock_is_shared_per_alias_and_receipt_is_complete() {
        let registry = crate::jarvis::agent_registry::AgentSessionRegistry::default();
        let first = registry.dispatch_lock("codex-1");
        let second = registry.dispatch_lock("codex-1");
        assert!(std::sync::Arc::ptr_eq(&first, &second));

        let receipt = StepExecutionReceipt {
            operation: PlanOperation::AgentSend,
            status: DISPATCH_SUBMISSION_UNCONFIRMED,
            target: Some("codex-1 — Codex — Traflix-Space".into()),
            message: "Scritto; avvio non confermato.".into(),
            recipient: Some(AgentRecipientReceipt {
                assignment_id: "assignment:test:1".into(),
                agent_alias: "codex-1".into(),
                agent_session_id: "session-codex-1".into(),
                terminal_id: "terminal-1".into(),
                generation: 7,
                process_id: Some(100),
                provider: "codex".into(),
                provider_session_id: Some("provider-session-1".into()),
                display_title: "Codex — Traflix-Space".into(),
            }),
            stages: unconfirmed_dispatch_stages(),
        };
        let json = serde_json::to_value(receipt).expect("receipt serializable");
        assert_eq!(json["recipient"]["agentAlias"], "codex-1");
        assert_eq!(json["recipient"]["agentSessionId"], "session-codex-1");
        assert_eq!(json["recipient"]["terminalId"], "terminal-1");
        assert_eq!(json["recipient"]["generation"], 7);
        assert_eq!(json["recipient"]["providerSessionId"], "provider-session-1");
        assert_eq!(json["status"], "submission_unconfirmed");
    }

    #[tokio::test]
    async fn simultaneous_sends_for_one_alias_wait_on_one_lock() {
        let registry = crate::jarvis::agent_registry::AgentSessionRegistry::default();
        let first = registry.dispatch_lock("codex-1");
        let second = registry.dispatch_lock("codex-1");
        let different_alias = registry.dispatch_lock("codex-2");
        let guard = first.lock().await;
        let waiter = tokio::spawn(async move {
            let _guard = second.lock().await;
            true
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        assert!(!std::sync::Arc::ptr_eq(&first, &different_alias));
        drop(guard);
        assert!(waiter.await.expect("lock waiter completed"));
    }

    #[test]
    fn automatic_title_is_short_and_aliases_are_not_title_based() {
        assert!(
            automatic_agent_title("Codex", Some("fix the voice normalization regression"))
                .chars()
                .count()
                <= 46
        );
        let workspace = WorkspaceConfig {
            id: "workspace-a".into(),
            name: "Workspace".into(),
            root_path: "C:\\repo".into(),
            layout: crate::workspace::registry::GridLayout { rows: 1, cols: 1 },
            terminals: vec![
                TerminalConfig {
                    id: "one".into(),
                    shell: "powershell.exe".into(),
                    agent_id: Some("codex".into()),
                    command: None,
                    cwd: "C:\\repo".into(),
                    title: "Codex".into(),
                    agent_alias: Some("codex".into()),
                    title_manual: false,
                    workspace_id: Some("workspace-a".into()),
                },
                TerminalConfig {
                    id: "two".into(),
                    shell: "powershell.exe".into(),
                    agent_id: Some("codex".into()),
                    command: None,
                    cwd: "C:\\repo".into(),
                    title: "Codex".into(),
                    agent_alias: Some("codex-2".into()),
                    title_manual: false,
                    workspace_id: Some("workspace-a".into()),
                },
            ],
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        assert_eq!(allocate_agent_alias(&workspace, "codex"), "codex-3");
    }
}
