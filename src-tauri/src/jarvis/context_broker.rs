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

    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            ..Self::new()
        }
    }

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

    pub fn invalidate(&self, workspace_id: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.invalidate(workspace_id);
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

    pub fn force_rebuild(
        &self,
        invocation: InvocationBinding,
        workspace_root: &Path,
        terminals: Vec<TerminalSummary>,
        requested_depth: RequestedDepth,
    ) -> Result<ContextPackageV1, crate::jarvis::types::JarvisErrorEnvelope> {
        self.invalidate(&invocation.target_workspace_id);
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
            DocumentationError::PathTraversal => {
                ("path_traversal", "path rejected by workspace policy")
            }
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
