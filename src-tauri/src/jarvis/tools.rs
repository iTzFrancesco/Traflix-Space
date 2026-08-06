use crate::jarvis::actions::PendingActionRegistry;
use crate::jarvis::agent_adapter::{context_from_status, LiveAgentContextSource};
use crate::jarvis::agent_registry::AgentSessionRegistry;
use crate::jarvis::context_broker::ContextBroker;
use crate::jarvis::memory::ConversationMemory;
use crate::jarvis::model::ModelProvider;
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{
    AgentMessage, AgentResult, AgentSessionContext, AgentSessionRef, ContextPackageV1,
    InvocationBinding, JarvisErrorEnvelope, Provenance, RequestedDepth, TerminalSummary,
    ToolEnvelope, WorkspaceSummary,
};
use crate::terminal_engine::TerminalManager;
use crate::workspace::registry::WorkspaceConfig;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub struct JarvisState {
    pub broker: ContextBroker,
    pub registry: Arc<AgentSessionRegistry>,
    pub memory: Arc<ConversationMemory>,
    pub model: ModelProvider,
    pub actions: Arc<PendingActionRegistry>,
}

impl Default for JarvisState {
    fn default() -> Self {
        let registry = Arc::new(AgentSessionRegistry::default());
        Self {
            broker: ContextBroker::with_source(Arc::new(LiveAgentContextSource::new(
                registry.clone(),
            ))),
            registry,
            memory: Arc::new(ConversationMemory::default()),
            model: ModelProvider::default(),
            actions: Arc::new(PendingActionRegistry::default()),
        }
    }
}

pub struct JarvisToolService<'a> {
    broker: &'a ContextBroker,
}

impl<'a> JarvisToolService<'a> {
    pub fn new(broker: &'a ContextBroker) -> Self {
        Self { broker }
    }

    pub fn workspace_list(
        &self,
        workspaces: &[WorkspaceConfig],
        observed_at: &str,
    ) -> ToolEnvelope<Vec<WorkspaceSummary>> {
        let mut data = workspaces
            .iter()
            .map(|workspace| WorkspaceSummary {
                id: workspace.id.clone(),
                name: workspace.name.clone(),
                root_path: workspace.root_path.clone(),
                terminal_count: workspace.terminals.len(),
                agent_count: workspace
                    .terminals
                    .iter()
                    .filter(|terminal| terminal.agent_id.is_some())
                    .count(),
                updated_at: workspace.updated_at.clone(),
            })
            .collect::<Vec<_>>();
        data.sort_by(|left, right| left.id.cmp(&right.id));
        ToolEnvelope {
            data,
            provenance: Provenance::trusted("workspace-registry", observed_at),
            warnings: Vec::new(),
        }
    }

    pub fn terminal_list(
        &self,
        workspace_id: &str,
        terminals: Vec<TerminalSummary>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Vec<TerminalSummary>>, JarvisErrorEnvelope> {
        if workspace_id.trim().is_empty() {
            return Err(error(
                "workspace_id_required",
                "workspaceId is required",
                None,
                None,
                observed_at,
            ));
        }
        if terminals
            .iter()
            .any(|terminal| terminal.workspace_id != workspace_id)
        {
            return Err(error(
                "terminal_workspace_mismatch",
                "terminal does not belong to workspace",
                None,
                Some(workspace_id.to_string()),
                observed_at,
            ));
        }
        Ok(ToolEnvelope {
            data: terminals,
            provenance: Provenance::trusted("terminal-manager", observed_at),
            warnings: Vec::new(),
        })
    }

    pub fn agent_list(
        &self,
        workspace_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Vec<AgentSessionRef>>, JarvisErrorEnvelope> {
        let sessions = self
            .broker
            .source()
            .list_sessions(workspace_id)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        Ok(ToolEnvelope {
            data: sessions,
            provenance: Provenance::trusted("agent-context-source", observed_at),
            warnings: Vec::new(),
        })
    }

    pub fn agent_snapshot(
        &self,
        workspace_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Vec<AgentSessionContext>>, JarvisErrorEnvelope> {
        let references = self
            .broker
            .source()
            .list_sessions(workspace_id)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        let mut sessions = Vec::with_capacity(references.len());
        for reference in references {
            let status = self
                .broker
                .source()
                .get_status(&reference)
                .map_err(|source| {
                    source_error(source, request_id.clone(), workspace_id, observed_at)
                })?;
            let result = self
                .broker
                .source()
                .get_last_result(&reference)
                .map_err(|source| {
                    source_error(source, request_id.clone(), workspace_id, observed_at)
                })?;
            let mut context = context_from_status(reference, status);
            context.last_result = result;
            sessions.push(context);
        }
        Ok(ToolEnvelope {
            data: sessions,
            provenance: Provenance::trusted("agent-registry", observed_at),
            warnings: Vec::new(),
        })
    }

    pub fn agent_status(
        &self,
        workspace_id: &str,
        session_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<AgentSessionContext>, JarvisErrorEnvelope> {
        let reference =
            self.resolve_session(workspace_id, session_id, request_id.clone(), observed_at)?;
        let status = self
            .broker
            .source()
            .get_status(&reference)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        Ok(ToolEnvelope {
            data: context_from_status(reference, status),
            provenance: Provenance::trusted("agent-context-source", observed_at),
            warnings: Vec::new(),
        })
    }

    pub fn agent_last_result(
        &self,
        workspace_id: &str,
        session_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Option<AgentResult>>, JarvisErrorEnvelope> {
        let reference =
            self.resolve_session(workspace_id, session_id, request_id.clone(), observed_at)?;
        let status = self
            .broker
            .source()
            .get_status(&reference)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        let result = self
            .broker
            .source()
            .get_last_result(&reference)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        let mut warnings = status.warnings;
        if result.is_none()
            && status
                .completion_notification
                .as_ref()
                .is_some_and(|notification| !notification.result_available)
        {
            warnings.push("completion observed, result unavailable".to_string());
        }
        Ok(ToolEnvelope {
            data: result,
            provenance: Provenance::trusted("agent-context-source", observed_at),
            warnings,
        })
    }

    pub fn agent_messages(
        &self,
        workspace_id: &str,
        session_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Vec<AgentMessage>>, JarvisErrorEnvelope> {
        let reference =
            self.resolve_session(workspace_id, session_id, request_id.clone(), observed_at)?;
        let messages = self
            .broker
            .source()
            .get_messages(&reference)
            .map_err(|source| source_error(source, request_id, workspace_id, observed_at))?;
        Ok(ToolEnvelope {
            data: messages,
            provenance: Provenance::untrusted("agent-context-source", observed_at),
            warnings: vec!["full messages requested explicitly".to_string()],
        })
    }

    pub fn build_context(
        &self,
        workspace: &WorkspaceConfig,
        invocation: InvocationBinding,
        terminals: Vec<TerminalSummary>,
        requested_depth: RequestedDepth,
    ) -> Result<ContextPackageV1, JarvisErrorEnvelope> {
        if workspace.id != invocation.target_workspace_id {
            return Err(error(
                "workspace_mismatch",
                "workspace does not match invocation target",
                Some(invocation.request_id.clone()),
                Some(invocation.target_workspace_id.clone()),
                &invocation.created_at,
            ));
        }
        if terminals
            .iter()
            .any(|terminal| terminal.workspace_id != invocation.target_workspace_id)
        {
            return Err(error(
                "terminal_workspace_mismatch",
                "terminal does not belong to invocation workspace",
                Some(invocation.request_id.clone()),
                Some(invocation.target_workspace_id.clone()),
                &invocation.created_at,
            ));
        }
        self.broker.build(
            invocation,
            std::path::Path::new(&workspace.root_path),
            terminals,
            requested_depth,
        )
    }

    pub fn refresh_context(
        &self,
        workspace: &WorkspaceConfig,
        invocation: InvocationBinding,
        terminals: Vec<TerminalSummary>,
        requested_depth: RequestedDepth,
    ) -> Result<ContextPackageV1, JarvisErrorEnvelope> {
        if workspace.id != invocation.target_workspace_id {
            return Err(error(
                "workspace_mismatch",
                "workspace does not match invocation target",
                Some(invocation.request_id.clone()),
                Some(invocation.target_workspace_id.clone()),
                &invocation.created_at,
            ));
        }
        if terminals
            .iter()
            .any(|terminal| terminal.workspace_id != invocation.target_workspace_id)
        {
            return Err(error(
                "terminal_workspace_mismatch",
                "terminal does not belong to invocation workspace",
                Some(invocation.request_id.clone()),
                Some(invocation.target_workspace_id.clone()),
                &invocation.created_at,
            ));
        }
        self.broker.refresh(
            invocation,
            std::path::Path::new(&workspace.root_path),
            terminals,
            requested_depth,
        )
    }

    fn resolve_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<AgentSessionRef, JarvisErrorEnvelope> {
        let sessions = self
            .broker
            .source()
            .list_sessions(workspace_id)
            .map_err(|source| {
                source_error(source, request_id.clone(), workspace_id, observed_at)
            })?;
        let reference = sessions
            .into_iter()
            .find(|session| session.agent_session_id == session_id)
            .ok_or_else(|| {
                error(
                    "agent_session_not_owned",
                    "agent session does not belong to workspace",
                    request_id.clone(),
                    Some(workspace_id.to_string()),
                    observed_at,
                )
            })?;
        if reference.workspace_id != workspace_id {
            return Err(error(
                "agent_session_workspace_mismatch",
                "agent session does not belong to workspace",
                request_id,
                Some(workspace_id.to_string()),
                observed_at,
            ));
        }
        Ok(reference)
    }
}

pub async fn list_terminals_for_workspace(
    manager: &TerminalManager,
    workspace_id: &str,
    observed_at: &str,
) -> Vec<TerminalSummary> {
    let sessions = manager
        .sessions
        .iter()
        .map(|entry| entry.value().clone())
        .collect::<Vec<_>>();
    let mut terminals = Vec::new();
    for session in sessions {
        let session = session.read().await;
        if session.workspace_id.as_deref() != Some(workspace_id) {
            continue;
        }
        let cwd = session
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .unwrap_or_default();
        terminals.push(TerminalSummary {
            terminal_id: session.id.clone(),
            workspace_id: workspace_id.to_string(),
            shell: session.shell.clone(),
            cwd,
            active: session.active,
            process_alive: session.process_alive.load(Ordering::Acquire),
            agent_id: session.agent_id.clone(),
            configured_agent_id: session.agent_id.clone(),
            observed_provider: session.observed_provider.clone(),
            resolved_provider: session
                .observed_provider
                .clone()
                .or_else(|| session.agent_id.as_deref().and_then(normalize_provider))
                .unwrap_or_else(|| "terminal-agent".to_string()),
            detection_source: session.detection_source.clone(),
            detection_confidence: session.detection_confidence,
            identity_warnings: session.identity_warnings.clone(),
            generation: session.generation,
            provenance: Provenance::trusted("terminal-manager", observed_at),
        });
    }
    terminals.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    terminals
}

fn source_error(
    source: crate::jarvis::agent_adapter::AgentSourceError,
    request_id: Option<String>,
    workspace_id: &str,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    JarvisErrorEnvelope::new(
        source.code,
        "agent context source unavailable",
        request_id,
        Some(workspace_id.to_string()),
        observed_at,
    )
}

fn error(
    code: &str,
    message: &str,
    request_id: Option<String>,
    workspace_id: Option<String>,
    observed_at: &str,
) -> JarvisErrorEnvelope {
    JarvisErrorEnvelope::new(code, message, request_id, workspace_id, observed_at)
}
