mod cell;
pub(crate) mod commands;
mod frame;
mod grid;
#[path = "manager_detection.rs"]
mod manager_detection;
#[path = "manager_identity.rs"]
mod manager_identity;
#[path = "manager_lifecycle.rs"]
mod manager_lifecycle;
#[path = "manager_notifications.rs"]
mod manager_notifications;
#[path = "manager_state.rs"]
mod manager_state;
#[path = "manager_vt.rs"]
mod manager_vt;
mod parser;
mod scheduler;
mod session;

pub use cell::{Cell, Color};
pub use frame::{FrameSnapshot, TerminalRehydrateState, TerminalRuntimeIdentity};
pub(crate) use session::AgentPresenceTransition;
pub use session::{TerminalSession, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS};

use dashmap::mapref::entry::Entry;
use dashmap::{DashMap, DashSet};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::jarvis::agent_registry::identity_source_priority;
#[cfg(windows)]
use crate::jarvis::runtime_detector::scan_process_tree_async;
use crate::jarvis::runtime_detector::{normalize_provider, AgentDetection};
use crate::terminal_engine::scheduler::FrameScheduler;

pub use crate::jarvis::agent_registry::{NormalizedTerminalText, TerminalAgentSnapshot};
pub(crate) use manager_identity::{
    apply_backend_launch_identity, apply_observed_provider, apply_runtime_identity,
    bounded_terminal_text, candidate_descendant_provider, promote_backend_launch_detection,
    snapshot_from_session,
};
pub(crate) use manager_notifications::{
    notify_agent_abort, notify_agent_exit, notify_agent_started, notify_agent_user_input,
};
pub(crate) use manager_vt::convert_vt_cell;

pub struct TerminalManager {
    pub sessions: DashMap<String, Arc<RwLock<TerminalSession>>>,
    scheduler: tokio::sync::Mutex<FrameScheduler>,
    /// Currently focused terminal id (avoids write-locking every session on set_active).
    active_id: tokio::sync::Mutex<Option<String>>,
    /// Serializes the brief check/insert seam with workspace shutdown. Without
    /// this gate, a stale TerminalPane spawn could land between a deletion
    /// sweep and the frontend unmount, leaving a PTY without a workspace.
    workspace_lifecycle: tokio::sync::Mutex<()>,
    closing_workspaces: DashSet<String>,
    next_generation: AtomicU64,
    detector_started: std::sync::atomic::AtomicBool,
}

/// Who wrote bytes into a PTY. The registry uses this to keep user prompts,
/// Jarvis follow-ups and backend control signals provenance-distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalInputOrigin {
    /// Typed/pasted by the user in the shared visible TUI.
    User,
    /// Jarvis follow-up written after a confirmed Pending Action.
    JarvisPrompt,
    /// Backend-generated Ctrl+C (confirmed `agent.abort`).
    JarvisAbort,
    /// Internal writes that must not be observed as user input.
    Internal,
}

/// Current terminal location and the branch resolved for that exact location.
/// Keeping the two values together prevents the title bar from showing a branch
/// that belongs to a previous directory after rapid `cd` commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    pub cwd: String,
    pub git_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCwdChanged {
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
    cwd: String,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::manager_lifecycle::ensure_spawn_workspace_matches;
    use super::{
        apply_backend_launch_identity, candidate_descendant_provider,
        promote_backend_launch_detection, TerminalInputOrigin, TerminalManager, TerminalSession,
    };
    use crate::jarvis::runtime_detector::AgentDetection;

    #[test]
    fn workspace_shutdown_gate_rejects_stale_spawns_until_explicitly_reopened() {
        let manager = TerminalManager::new();
        assert!(manager
            .ensure_workspace_accepts_spawns("workspace-a")
            .is_ok());

        manager.closing_workspaces.insert("workspace-a".into());
        assert_eq!(
            manager
                .ensure_workspace_accepts_spawns("workspace-a")
                .unwrap_err(),
            "workspace-closing: workspace-a",
        );
        assert!(manager
            .ensure_workspace_accepts_spawns("workspace-b")
            .is_ok());

        manager.allow_workspace_spawns("workspace-a");
        assert!(manager
            .ensure_workspace_accepts_spawns("workspace-a")
            .is_ok());
    }

    #[test]
    fn spawn_never_reuses_a_terminal_id_from_another_workspace() {
        assert!(ensure_spawn_workspace_matches(Some("workspace-a"), "workspace-a").is_ok());
        assert_eq!(
            ensure_spawn_workspace_matches(Some("workspace-b"), "workspace-a").unwrap_err(),
            "terminal-workspace-mismatch: existing PTY belongs to another workspace",
        );
    }

    #[test]
    fn backend_owned_launch_is_trusted_but_manual_command_is_not() {
        let detection = AgentDetection {
            provider: "codex".to_string(),
            source: "command-observed".to_string(),
            confidence: 0.7,
        };

        let trusted = promote_backend_launch_detection(
            TerminalInputOrigin::Internal,
            Some("starting"),
            Some("codex"),
            detection.clone(),
        );
        assert_eq!(trusted.source, "backend-launch");
        assert_eq!(trusted.confidence, 1.0);

        let mut session = TerminalSession::new(
            "terminal-1".to_string(),
            "Codex".to_string(),
            "powershell.exe".to_string(),
            "C:\\workspace".to_string(),
            80,
            24,
        );
        apply_backend_launch_identity(&mut session, &trusted);
        assert_eq!(session.agent_runtime_presence.alive(), None);

        let manual = promote_backend_launch_detection(
            TerminalInputOrigin::User,
            Some("starting"),
            Some("codex"),
            detection.clone(),
        );
        assert_eq!(manual, detection);

        let mismatched = promote_backend_launch_detection(
            TerminalInputOrigin::Internal,
            Some("starting"),
            Some("pi"),
            detection,
        );
        assert_eq!(mismatched.source, "command-observed");
        assert_eq!(mismatched.confidence, 0.7);
    }

    #[test]
    fn exited_manual_agent_is_not_repromoted_by_an_unknown_launcher() {
        let mut session = TerminalSession::new(
            "terminal-1".to_string(),
            "Codex".to_string(),
            "powershell.exe".to_string(),
            "C:\\workspace".to_string(),
            80,
            24,
        );
        session.agent_id = Some("codex".to_string());
        assert!(candidate_descendant_provider(&session).is_none());

        session.backend_agent_launch_state = Some("ready".to_string());
        assert_eq!(
            candidate_descendant_provider(&session).as_deref(),
            Some("codex")
        );

        session.backend_agent_launch_state = None;
        session.observed_provider = Some("codex".to_string());
        assert_eq!(
            candidate_descendant_provider(&session).as_deref(),
            Some("codex")
        );
    }
}
