use crate::jarvis::agent_adapter::{
    context_from_status, AgentContextSource, EmptyAgentContextSource,
};
use crate::jarvis::cache::ContextCache;
use crate::jarvis::documentation::{DocumentationError, DocumentationLimits};
use crate::jarvis::types::{
    AgentSessionContext, AgentState, ContextPackageV1, InvocationBinding, RequestedDepth,
    TerminalSummary,
};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Compact agent overview bound: at most the 8 most recently created sessions
/// are included in a Context Package when no explicit session target is set.
const MAX_AGENT_OVERVIEW_SESSIONS: usize = 8;
/// Serialized agent overview budget: 6 KiB. Older sessions are dropped until
/// the overview fits, so the model view never grows unbounded.
const MAX_AGENT_OVERVIEW_BYTES: usize = 6 * 1024;

pub trait Clock: Send + Sync {
    fn now(&self) -> String;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
}

pub struct ContextBroker {
    cache: Mutex<ContextCache>,
    source: Arc<dyn AgentContextSource>,
    clock: Arc<dyn Clock>,
    limits: DocumentationLimits,
}

impl Default for ContextBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ContextBroker {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(ContextCache::default()),
            source: Arc::new(EmptyAgentContextSource),
            clock: Arc::new(SystemClock),
            limits: DocumentationLimits::default(),
        }
    }

    #[cfg(test)]
    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            ..Self::new()
        }
    }

    #[cfg(test)]
    pub fn with_source_and_clock(
        source: Arc<dyn AgentContextSource>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            source,
            clock,
            ..Self::new()
        }
    }

    pub fn with_source(source: Arc<dyn AgentContextSource>) -> Self {
        Self {
            source,
            ..Self::new()
        }
    }

    pub fn build(
        &self,
        invocation: InvocationBinding,
        workspace_root: &Path,
        terminals: Vec<TerminalSummary>,
        requested_depth: RequestedDepth,
    ) -> Result<ContextPackageV1, crate::jarvis::types::JarvisErrorEnvelope> {
        let generated_at = self.clock.now();
        let cache_output = self
            .cache
            .lock()
            .map_err(|_| {
                self.error(
                    "cache_unavailable",
                    "context cache unavailable",
                    &invocation,
                )
            })?
            .build(
                &invocation.target_workspace_id,
                workspace_root,
                &generated_at,
                &self.limits,
                None,
            )
            .map_err(|error| self.map_documentation_error(error, &invocation))?;

        let mut warnings = cache_output.context.warnings.clone();
        let mut agent_sessions = Vec::new();
        let source_sessions = match self.source.list_sessions(&invocation.target_workspace_id) {
            Ok(sessions) => sessions,
            Err(error) => {
                warnings.push(format!("agent source unavailable: {}", error.code));
                Vec::new()
            }
        };

        if let Some(target_session_id) = invocation.target_agent_session_id.as_deref() {
            if !source_sessions
                .iter()
                .any(|session| session.agent_session_id == target_session_id)
            {
                return Err(self.error(
                    "agent_session_not_owned",
                    "agent session does not belong to target workspace",
                    &invocation,
                ));
            }
        }

        for reference in source_sessions {
            if invocation
                .target_agent_session_id
                .as_deref()
                .is_some_and(|target| target != reference.agent_session_id)
            {
                continue;
            }

            let mut context = match self.source.get_status(&reference) {
                Ok(status) => context_from_status(reference.clone(), status),
                Err(error) => AgentSessionContext {
                    reference: reference.clone(),
                    configured_agent_id: reference.configured_agent_id.clone(),
                    observed_provider: reference.observed_provider.clone(),
                    resolved_provider: reference.resolved_provider.clone(),
                    detection_source: reference.detection_source.clone(),
                    detection_confidence: reference.detection_confidence,
                    identity_warnings: reference.identity_warnings.clone(),
                    identity_needs_confirmation: reference.identity_needs_confirmation,
                    objective: None,
                    state: AgentState::Unknown,
                    last_turn: None,
                    last_result: None,
                    completion_notification: None,
                    messages: None,
                    provenance: crate::jarvis::types::Provenance::trusted(
                        "agent-context-source",
                        &generated_at,
                    ),
                    confidence: 0.0,
                    warnings: vec![format!("agent status unavailable: {}", error.code)],
                    current_task: None,
                    last_activity_at: None,
                },
            };

            if requested_depth != RequestedDepth::Summary {
                match self.source.get_last_result(&reference) {
                    Ok(result) => {
                        if result.is_none()
                            && context
                                .completion_notification
                                .as_ref()
                                .is_some_and(|notification| !notification.result_available)
                        {
                            context
                                .warnings
                                .push("completion observed, result unavailable".to_string());
                        }
                        context.last_result = result;
                    }
                    Err(error) => context
                        .warnings
                        .push(format!("agent result unavailable: {}", error.code)),
                }
            }

            if requested_depth == RequestedDepth::FullMessages {
                match self.source.get_messages(&reference) {
                    Ok(messages) => context.messages = Some(messages),
                    Err(error) => context
                        .warnings
                        .push(format!("agent messages unavailable: {}", error.code)),
                }
            }

            warnings.extend(context.warnings.clone());
            agent_sessions.push(context);
        }

        warnings.sort();
        warnings.dedup();
        let agent_sessions = compact_agent_overview(agent_sessions);
        Ok(ContextPackageV1 {
            package_version: "1".to_string(),
            invocation,
            documentation: cache_output.context,
            terminals,
            agent_sessions,
            requested_depth,
            warnings,
        })
    }

    pub fn refresh(
        &self,
        invocation: InvocationBinding,
        workspace_root: &Path,
        terminals: Vec<TerminalSummary>,
        requested_depth: RequestedDepth,
    ) -> Result<ContextPackageV1, crate::jarvis::types::JarvisErrorEnvelope> {
        self.build(invocation, workspace_root, terminals, requested_depth)
    }

    pub(crate) fn source(&self) -> &dyn AgentContextSource {
        self.source.as_ref()
    }

    fn map_documentation_error(
        &self,
        error: DocumentationError,
        invocation: &InvocationBinding,
    ) -> crate::jarvis::types::JarvisErrorEnvelope {
        let (code, message) = match error {
            DocumentationError::RootResolution => {
                ("workspace_root_unavailable", "workspace root unavailable")
            }
            DocumentationError::RootNotDirectory => (
                "workspace_root_invalid",
                "workspace root is not a directory",
            ),
            #[cfg(test)]
            DocumentationError::PathTraversal => {
                ("path_traversal", "path rejected by workspace policy")
            }
            #[cfg(test)]
            DocumentationError::OutsideWorkspace => (
                "path_outside_workspace",
                "path rejected by workspace policy",
            ),
            DocumentationError::Timeout => {
                ("context_timeout", "documentation collection timed out")
            }
            DocumentationError::Cancelled => {
                ("context_cancelled", "documentation collection cancelled")
            }
            #[cfg(not(test))]
            DocumentationError::Io => (
                "documentation_unavailable",
                "documentation collection unavailable",
            ),
            #[cfg(test)]
            DocumentationError::NotMarkdown
            | DocumentationError::SensitivePath
            | DocumentationError::ExcludedPath
            | DocumentationError::Io => (
                "documentation_unavailable",
                "documentation collection unavailable",
            ),
        };
        self.error(code, message, invocation)
    }

    fn error(
        &self,
        code: &str,
        message: &str,
        invocation: &InvocationBinding,
    ) -> crate::jarvis::types::JarvisErrorEnvelope {
        crate::jarvis::types::JarvisErrorEnvelope::new(
            code,
            message,
            Some(invocation.request_id.clone()),
            Some(invocation.target_workspace_id.clone()),
            self.clock.now(),
        )
    }
}

/// Keep the agent overview of a Context Package compact: at most
/// `MAX_AGENT_OVERVIEW_SESSIONS` sessions (most recently created first) and a
/// serialized budget of `MAX_AGENT_OVERVIEW_BYTES`. Older sessions are dropped
/// only from the model-facing overview; the registry keeps its own bounded
/// history for identity and reconciliation.
fn compact_agent_overview(mut sessions: Vec<AgentSessionContext>) -> Vec<AgentSessionContext> {
    sessions.sort_by(|left, right| {
        right
            .reference
            .created_at
            .cmp(&left.reference.created_at)
            .then_with(|| {
                right
                    .reference
                    .agent_session_id
                    .cmp(&left.reference.agent_session_id)
            })
    });
    sessions.truncate(MAX_AGENT_OVERVIEW_SESSIONS);
    while sessions.len() > 1 {
        let Ok(size) = serde_json::to_vec(&sessions) else {
            break;
        };
        if size.len() <= MAX_AGENT_OVERVIEW_BYTES {
            break;
        }
        sessions.pop();
    }
    sessions
}

#[cfg(test)]
mod compact_tests {
    use super::super::types::{AgentSessionContext, AgentSessionRef, Provenance};
    use super::compact_agent_overview;

    fn session(id: &str, created_at: &str) -> AgentSessionContext {
        AgentSessionContext {
            reference: AgentSessionRef {
                agent_session_id: id.to_string(),
                provider: "codex".to_string(),
                configured_agent_id: None,
                observed_provider: None,
                resolved_provider: "codex".to_string(),
                detection_source: "test".to_string(),
                detection_confidence: 1.0,
                identity_warnings: Vec::new(),
                identity_needs_confirmation: false,
                workspace_id: "workspace-a".to_string(),
                terminal_id: Some(format!("terminal-{id}")),
                generation: 1,
                provider_session_id: None,
                provider_turn_id: None,
                created_at: created_at.to_string(),
                updated_at: created_at.to_string(),
                current_task: None,
                last_activity_at: None,
            },
            configured_agent_id: None,
            observed_provider: None,
            resolved_provider: "codex".to_string(),
            detection_source: "test".to_string(),
            detection_confidence: 1.0,
            identity_warnings: Vec::new(),
            identity_needs_confirmation: false,
            objective: None,
            state: super::super::types::AgentState::Working,
            last_turn: None,
            last_result: None,
            completion_notification: None,
            current_task: None,
            last_activity_at: None,
            messages: None,
            provenance: Provenance::trusted("test", created_at),
            confidence: 1.0,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn overview_is_limited_to_eight_most_recent_sessions() {
        let sessions = (1..=20)
            .map(|index| {
                session(
                    &format!("session-{index}"),
                    &format!("2026-08-07T00:{index:02}:00Z"),
                )
            })
            .collect::<Vec<_>>();
        let compact = compact_agent_overview(sessions);
        assert!(compact.len() <= 8);
        assert_eq!(compact[0].reference.agent_session_id, "session-20");
        assert!(compact.iter().all(|item| {
            let id = item
                .reference
                .agent_session_id
                .strip_prefix("session-")
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            id >= 13
        }));
    }

    #[test]
    fn overview_fits_the_byte_budget_when_sessions_are_heavy() {
        let sessions = (0..8)
            .map(|index| {
                let mut item = session(
                    &format!("heavy-{index}"),
                    &format!("2026-08-07T00:{index:02}:00Z"),
                );
                item.current_task = Some(super::super::types::AgentTaskContext {
                    text: "x".repeat(2048),
                    source: super::super::types::AgentInteractionSource::User,
                    started_at: "2026-08-07T00:00:00Z".to_string(),
                    completed_at: None,
                    confidence: 0.65,
                    untrusted: true,
                });
                item
            })
            .collect::<Vec<_>>();
        let compact = compact_agent_overview(sessions);
        assert!(compact.len() < 8);
        let size = serde_json::to_vec(&compact).unwrap().len();
        assert!(size <= 6 * 1024);
    }
}
