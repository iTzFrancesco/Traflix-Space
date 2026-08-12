use crate::jarvis::actions::PendingActionRegistry;
use crate::jarvis::agent_adapter::{context_from_status, LiveAgentContextSource};
use crate::jarvis::agent_registry::{AgentSessionRegistry, MAX_ACTIVITY_LIMIT};
use crate::jarvis::context_broker::ContextBroker;
use crate::jarvis::memory::ConversationMemory;
use crate::jarvis::model::{CodexAppServerProvider, JarvisModelProvider};
use crate::jarvis::requests::ChatRequestRegistry;
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::{
    AgentActivityEvent, AgentMessage, AgentResult, AgentSessionContext, AgentSessionRef,
    ContextPackageV1, InvocationBinding, JarvisErrorEnvelope, Provenance, RequestedDepth,
    TerminalSummary, ToolEnvelope, WorkspaceSummary,
};
use crate::terminal_engine::TerminalManager;
use crate::workspace::registry::WorkspaceConfig;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct JarvisState {
    pub broker: ContextBroker,
    pub registry: Arc<AgentSessionRegistry>,
    pub memory: Arc<ConversationMemory>,
    pub model: Arc<dyn JarvisModelProvider>,
    pub actions: Arc<PendingActionRegistry>,
    pub chat_requests: Arc<ChatRequestRegistry>,
    pub control: Arc<crate::jarvis::control::ConversationalControlState>,
}

impl Default for JarvisState {
    fn default() -> Self {
        Self::with_memory(Arc::new(ConversationMemory::default()))
    }
}

impl JarvisState {
    pub fn new(app: &AppHandle) -> Self {
        let memory = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| ConversationMemory::persistent(dir.join("jarvis-memory-v1.json")))
            .unwrap_or_default();
        Self::with_memory(Arc::new(memory))
    }

    fn with_memory(memory: Arc<ConversationMemory>) -> Self {
        let registry = Arc::new(AgentSessionRegistry::default());
        Self {
            broker: ContextBroker::with_source(Arc::new(LiveAgentContextSource::new(
                registry.clone(),
            ))),
            registry,
            memory,
            model: Arc::new(CodexAppServerProvider::default()),
            actions: Arc::new(PendingActionRegistry::default()),
            chat_requests: Arc::new(ChatRequestRegistry::default()),
            control: Arc::new(crate::jarvis::control::ConversationalControlState::default()),
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

    pub fn agent_activity(
        &self,
        workspace_id: &str,
        session_id: &str,
        limit: usize,
        request_id: Option<String>,
        observed_at: &str,
    ) -> Result<ToolEnvelope<Vec<AgentActivityEvent>>, JarvisErrorEnvelope> {
        let reference =
            self.resolve_session(workspace_id, session_id, request_id.clone(), observed_at)?;
        let limit = limit.clamp(1, MAX_ACTIVITY_LIMIT);
        let events = self
            .broker
            .source()
            .get_activity(&reference, limit)
            .map_err(|source| source_error(source, request_id, workspace_id, observed_at))?;
        Ok(ToolEnvelope {
            data: events,
            provenance: Provenance::trusted("agent-registry", observed_at),
            warnings: Vec::new(),
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
    workspace: &WorkspaceConfig,
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
        if session.workspace_id.as_deref() != Some(workspace.id.as_str()) {
            continue;
        }
        let cwd = session
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .unwrap_or_default();
        terminals.push(TerminalSummary {
            terminal_id: session.id.clone(),
            workspace_id: workspace.id.clone(),
            title: effective_terminal_title(
                &session.title,
                session
                    .is_agent_terminal
                    .then_some(session.agent_id.as_deref())
                    .flatten(),
                &session.shell,
                &cwd,
            ),
            shell: session.shell.clone(),
            cwd,
            active: session.active,
            process_id: session.process_id,
            process_alive: session.process_alive.load(Ordering::Acquire),
            agent_id: session
                .is_agent_terminal
                .then(|| session.agent_id.clone())
                .flatten(),
            configured_agent_id: session.agent_id.clone(),
            observed_provider: session.observed_provider.clone(),
            resolved_provider: if session.is_agent_terminal {
                session
                    .observed_provider
                    .clone()
                    .or_else(|| session.agent_id.as_deref().and_then(normalize_provider))
                    .unwrap_or_else(|| "terminal-agent".to_string())
            } else {
                "powershell".to_string()
            },
            detection_source: session.detection_source.clone(),
            detection_confidence: session.detection_confidence,
            identity_warnings: session.identity_warnings.clone(),
            generation: session.generation,
            provenance: Provenance::trusted("terminal-manager", observed_at),
        });
    }
    canonicalize_terminal_order(terminals, workspace)
}

/// The persisted workspace order is the UI/Jarvis source of truth. Live PTYs
/// missing from an older config are retained as deterministic extras so the
/// unordered DashMap iteration can never become a semantic terminal index.
pub fn canonicalize_terminal_order(
    terminals: Vec<TerminalSummary>,
    workspace: &WorkspaceConfig,
) -> Vec<TerminalSummary> {
    let mut runtime = terminals
        .into_iter()
        .map(|terminal| (terminal.terminal_id.clone(), terminal))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(runtime.len());
    for config in &workspace.terminals {
        if let Some(mut terminal) = runtime.remove(&config.id) {
            let configured_title = if terminal.agent_id.is_none()
                && is_default_terminal_title(&config.title, config.agent_id.as_deref())
            {
                "Terminal"
            } else {
                &config.title
            };
            terminal.title = effective_terminal_title(
                configured_title,
                terminal.agent_id.as_deref(),
                &terminal.shell,
                &terminal.cwd,
            );
            ordered.push(terminal);
        }
    }
    let mut extras = runtime.into_values().collect::<Vec<_>>();
    extras.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    ordered.extend(extras);
    ordered
}

pub fn effective_terminal_title(
    configured_title: &str,
    agent_id: Option<&str>,
    shell: &str,
    cwd: &str,
) -> String {
    let agent_name = agent_id.map(agent_display_name);
    let configured = configured_title.trim();
    let is_default = is_default_terminal_title(configured, agent_id);
    if !is_default {
        return configured.to_string();
    }
    let project = cwd
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .trim();
    let project = if project.is_empty() {
        "workspace"
    } else {
        project
    };
    match agent_name {
        Some(name) => format!("{name} — {project}"),
        None => format!("{shell} — {project}"),
    }
}

fn is_default_terminal_title(configured_title: &str, agent_id: Option<&str>) -> bool {
    let configured = configured_title.trim();
    configured.is_empty()
        || configured.eq_ignore_ascii_case("terminal")
        || configured.eq_ignore_ascii_case("terminale")
        || agent_id
            .map(agent_display_name)
            .as_deref()
            .is_some_and(|name| configured.eq_ignore_ascii_case(name))
}

fn agent_display_name(agent_id: &str) -> String {
    match agent_id.trim().to_ascii_lowercase().as_str() {
        "codex" => "Codex".to_string(),
        "opencode" => "OpenCode".to_string(),
        "claude" => "Claude".to_string(),
        "pi" => "PI".to_string(),
        "freebuff" => "Freebuff".to_string(),
        "anti-gravity" | "agy" => "Anti-Gravity".to_string(),
        "cline" => "Cline".to_string(),
        "cmdc" => "Command Code".to_string(),
        value => value.to_string(),
    }
}

pub fn attach_terminal_titles(sessions: &mut [AgentSessionContext], terminals: &[TerminalSummary]) {
    for session in sessions {
        session.reference.terminal_title = session
            .reference
            .terminal_id
            .as_deref()
            .and_then(|terminal_id| {
                terminals.iter().find(|terminal| {
                    terminal.terminal_id == terminal_id
                        && terminal.generation == session.reference.generation
                        && terminal.workspace_id == session.reference.workspace_id
                })
            })
            .map(|terminal| terminal.title.clone());
    }
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

#[cfg(test)]
mod terminal_order_tests {
    use super::canonicalize_terminal_order;
    use crate::jarvis::types::{Provenance, TerminalSummary};
    use crate::workspace::registry::{GridLayout, TerminalConfig, WorkspaceConfig};

    fn terminal(id: &str, title: &str) -> TerminalSummary {
        TerminalSummary {
            terminal_id: id.into(),
            workspace_id: "workspace".into(),
            title: title.into(),
            shell: "powershell.exe".into(),
            cwd: "C:\\repo".into(),
            active: false,
            process_id: Some(42),
            process_alive: true,
            agent_id: None,
            configured_agent_id: None,
            observed_provider: None,
            resolved_provider: "terminal-agent".into(),
            detection_source: "test".into(),
            detection_confidence: 1.0,
            identity_warnings: vec![],
            generation: 1,
            provenance: Provenance::trusted("test", "now"),
        }
    }

    fn config(id: &str, title: &str) -> TerminalConfig {
        TerminalConfig {
            id: id.into(),
            shell: "powershell.exe".into(),
            agent_id: None,
            command: None,
            cwd: "C:\\repo".into(),
            title: title.into(),
            workspace_id: Some("workspace".into()),
        }
    }

    #[test]
    fn persisted_order_and_effective_navbar_titles_win_while_runtime_extras_are_sorted() {
        let workspace = WorkspaceConfig {
            id: "workspace".into(),
            name: "Workspace".into(),
            root_path: "C:\\repo".into(),
            layout: GridLayout { rows: 2, cols: 2 },
            terminals: vec![config("right", "Right"), config("left", "Left")],
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let ordered = canonicalize_terminal_order(
            vec![
                terminal("z-extra", "Z"),
                terminal("left", "runtime-left"),
                terminal("ä-extra", "Unicode"),
                terminal("\u{e000}-extra", "Private use"),
                terminal("\u{10000}-extra", "Supplementary"),
                terminal("A-extra", "Uppercase"),
                terminal("a-extra", "A"),
                terminal("right", "runtime-right"),
            ],
            &workspace,
        );
        assert_eq!(
            ordered
                .iter()
                .map(|terminal| terminal.terminal_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "right",
                "left",
                "A-extra",
                "a-extra",
                "z-extra",
                "ä-extra",
                "\u{e000}-extra",
                "\u{10000}-extra",
            ]
        );
        assert_eq!(ordered[0].title, "Right");
        assert_eq!(ordered[1].title, "Left");
    }

    #[test]
    fn default_agent_title_is_the_same_automatic_title_shown_in_the_navbar() {
        let mut terminal = terminal("codex-pane", "Codex");
        terminal.cwd = "C:\\work\\Traflix-Space".into();
        terminal.agent_id = Some("codex".into());
        terminal.configured_agent_id = Some("codex".into());
        terminal.resolved_provider = "codex".into();
        let workspace = WorkspaceConfig {
            id: "workspace".into(),
            name: "Workspace".into(),
            root_path: "C:\\work\\Traflix-Space".into(),
            layout: GridLayout { rows: 1, cols: 1 },
            terminals: vec![TerminalConfig {
                agent_id: Some("codex".into()),
                title: "Codex".into(),
                ..config("codex-pane", "Codex")
            }],
            created_at: "now".into(),
            updated_at: "now".into(),
        };

        let ordered = canonicalize_terminal_order(vec![terminal], &workspace);
        assert_eq!(ordered[0].title, "Codex — Traflix-Space");
    }

    #[test]
    fn exited_agent_child_exposes_the_remaining_powershell_terminal() {
        let mut terminal = terminal("codex-pane", "Codex");
        terminal.cwd = "C:\\work\\Traflix-Space".into();
        terminal.agent_id = None;
        terminal.configured_agent_id = Some("codex".into());
        terminal.resolved_provider = "powershell".into();
        terminal.detection_source = "agent-process-exited".into();
        let workspace = WorkspaceConfig {
            id: "workspace".into(),
            name: "Workspace".into(),
            root_path: "C:\\work\\Traflix-Space".into(),
            layout: GridLayout { rows: 1, cols: 1 },
            terminals: vec![TerminalConfig {
                agent_id: Some("codex".into()),
                title: "Codex".into(),
                ..config("codex-pane", "Codex")
            }],
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let ordered = canonicalize_terminal_order(vec![terminal], &workspace);
        assert_eq!(ordered[0].resolved_provider, "powershell");
        assert_eq!(ordered[0].title, "powershell.exe — Traflix-Space");
        assert!(ordered[0].agent_id.is_none());
        assert_eq!(ordered[0].configured_agent_id.as_deref(), Some("codex"));
    }
}
