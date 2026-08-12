mod cell;
pub(crate) mod commands;
mod frame;
mod grid;
mod parser;
mod scheduler;
mod session;

pub use cell::{Cell, Color};
pub use frame::{FrameSnapshot, TerminalRehydrateState, TerminalRuntimeIdentity};
use session::AgentPresenceTransition;
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

impl TerminalManager {
    pub fn new() -> Self {
        // Persisted terminal ids survive app restarts. Seed the lifetime token
        // from wall-clock microseconds so a late hook/event from the previous
        // Traflix process cannot collide with generation 1 in the new process.
        // Microseconds remain exact in JavaScript's Number representation.
        let generation_seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_micros().min(9_007_199_254_740_990_u128) as u64)
            .unwrap_or(1);
        Self {
            sessions: DashMap::new(),
            scheduler: tokio::sync::Mutex::new(FrameScheduler::new()),
            active_id: tokio::sync::Mutex::new(None),
            workspace_lifecycle: tokio::sync::Mutex::new(()),
            closing_workspaces: DashSet::new(),
            next_generation: AtomicU64::new(generation_seed),
            detector_started: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub async fn spawn(
        &self,
        app: AppHandle,
        config: crate::workspace::registry::TerminalConfig,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let id = config.id.clone();
        let initial_cols = cols.max(MIN_TERMINAL_COLS);
        let initial_rows = rows.max(MIN_TERMINAL_ROWS);
        let workspace_id = config.workspace_id.clone().unwrap_or_default();
        let lifecycle = self.workspace_lifecycle.lock().await;
        self.ensure_workspace_accepts_spawns(&workspace_id)?;

        // Reuse a live PTY. If it exited while the frontend was unmounted,
        // report that state instead of silently replacing an agent session
        // with a fresh shell; `terminal_reopen` is the explicit restart path.
        loop {
            if let Some(entry) = self.sessions.get(&id) {
                let session = entry.value().clone();
                drop(entry);
                let session_state = session.read().await;
                let process_alive = session_state.process_alive.load(Ordering::Acquire);
                let spawn_in_progress = session_state.pty.is_none();
                ensure_spawn_workspace_matches(
                    session_state.workspace_id.as_deref(),
                    &workspace_id,
                )?;
                drop(session_state);

                if process_alive || spawn_in_progress {
                    info!(terminal_id = %id, "Terminal session already exists, reusing");
                    // The existing PTY owns the live TUI geometry. The
                    // frontend synchronizes the measured DOM size after
                    // layout; resizing here would force a freshly mounted
                    // xterm's default 80x24 onto a running TUI.
                    if let Ok(Some(snapshot)) = self.get_agent_snapshot(&id).await {
                        if snapshot.is_agent_terminal {
                            notify_agent_started(&app, &snapshot);
                        }
                    }
                    return Ok(id);
                }

                info!(terminal_id = %id, "Terminal session already exited");
                return Err(format!("terminal-exited: {}", id));
            }

            // Atomic check-or-insert. If another caller inserts between the
            // lookup and this entry operation, loop and inspect its state.
            match self.sessions.entry(id.clone()) {
                Entry::Occupied(entry) => {
                    drop(entry);
                    continue;
                }
                Entry::Vacant(slot) => {
                    let shell = if config.shell.is_empty() {
                        "powershell.exe".to_string()
                    } else {
                        config.shell.clone()
                    };
                    let cwd_raw = if config.cwd.is_empty() {
                        std::env::current_dir()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| ".".to_string())
                    } else {
                        config.cwd.clone()
                    };
                    // Strip Windows extended-length prefixes that break some shells.
                    let cwd = cwd_raw
                        .trim_start_matches("\\\\?\\")
                        .trim_start_matches("\\\\.\\")
                        .to_string();

                    let generation = self.next_generation.fetch_add(1, Ordering::AcqRel);
                    let mut session = TerminalSession::new(
                        id.clone(),
                        if config.title.trim().is_empty() {
                            "Terminal".to_string()
                        } else {
                            config.title.clone()
                        },
                        shell,
                        cwd,
                        initial_cols,
                        initial_rows,
                    );
                    session.generation = generation;
                    session.is_agent_terminal = config.agent_id.is_some();
                    session.agent_id = config.agent_id.clone();
                    session.agent_alias = config.agent_alias.clone();
                    if session.agent_id.is_some() {
                        session.detection_source = "configured-hint".to_string();
                        session.detection_confidence = 0.65;
                    }
                    session.workspace_id = config.workspace_id.clone();
                    slot.insert(Arc::new(RwLock::new(session)));
                    info!(terminal_id = %id, "Terminal session created");
                    break;
                }
            }
        }
        // Spawn the shell immediately so the PTY reader starts sending output.
        // Keep the lifecycle barrier through this cutover: otherwise an exact
        // close can remove the map entry while spawn_shell still owns its Arc,
        // allowing an untracked child process to be created after removal.
        if let Err(e) = self.spawn_shell(&app, &id).await {
            let _ = self.sessions.remove(&id);
            return Err(e);
        }
        drop(lifecycle);

        if let Some(snapshot) = self.get_agent_snapshot(&id).await.ok().flatten() {
            if snapshot.is_agent_terminal {
                notify_agent_started(&app, &snapshot);
            }
        }

        Ok(id)
    }

    pub async fn spawn_shell(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was removed before spawn".to_string());
        }
        if session.pty.is_some() {
            if session.process_alive.load(Ordering::Acquire) {
                return Ok(());
            }
            return Err(format!("terminal-exited: {}", id));
        }
        if session.process_id.is_some() && !session.process_alive.load(Ordering::Acquire) {
            return Err(format!("terminal-exited: {}", id));
        }
        session.spawn(app.clone()).await?;
        info!(terminal_id = %id, "Shell spawned");
        Ok(())
    }

    pub async fn runtime_identity(&self, id: &str) -> Result<TerminalRuntimeIdentity, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(TerminalRuntimeIdentity {
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            generation: session.generation,
            process_id: session.process_id,
            agent_launch_owner: session
                .backend_agent_launch_state
                .as_ref()
                .map(|_| "backend".to_string()),
            agent_launch_state: session.backend_agent_launch_state.clone(),
        })
    }

    pub async fn set_backend_agent_launch_state(
        &self,
        id: &str,
        expected: &TerminalRuntimeIdentity,
        launch_state: &str,
    ) -> Result<(), String> {
        if !matches!(launch_state, "starting" | "ready" | "failed") {
            return Err("invalid backend agent launch state".to_string());
        }
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if session.workspace_id.as_deref().unwrap_or_default() != expected.workspace_id.as_str() {
            return Err("stale-terminal-workspace: backend launch session changed".to_string());
        }
        if session.generation != expected.generation {
            return Err("stale-terminal-generation: backend launch session changed".to_string());
        }
        if session.process_id != expected.process_id {
            return Err("stale-terminal-process: backend launch session changed".to_string());
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        session.backend_agent_launch_state = Some(launch_state.to_string());
        Ok(())
    }

    /// Validate all stable coordinates of a PTY lifetime before an IPC-side
    /// mutation. Generation prevents reopen races, process id prevents an
    /// accidental same-generation process substitution, and workspace id
    /// prevents a globally reused terminal id from crossing workspace seams.
    pub async fn validate_runtime_identity(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
        let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
        if workspace_id != expected_workspace_id {
            return Err(format!(
                "stale-terminal-workspace: expected {}, current {}",
                expected_workspace_id, workspace_id
            ));
        }
        if session.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, session.generation
            ));
        }
        if session.process_id != expected_process_id {
            return Err(format!(
                "stale-terminal-process: expected {:?}, current {:?}",
                expected_process_id, session.process_id
            ));
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(())
    }

    async fn session_for_runtime(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<Arc<RwLock<TerminalSession>>, String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        {
            let session = session_arc.read().await;
            let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
            if workspace_id != expected_workspace_id {
                return Err(format!(
                    "stale-terminal-workspace: expected {}, current {}",
                    expected_workspace_id, workspace_id
                ));
            }
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(session_arc)
    }

    /// Snapshot discovery still validates workspace. Once generation/process
    /// are known, the caller supplies them and receives the same exact checks
    /// used by mutations.
    async fn validate_rehydrate_scope(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: Option<u64>,
        expected_process_id: Option<u32>,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
        let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
        if workspace_id != expected_workspace_id {
            return Err(format!(
                "stale-terminal-workspace: expected {}, current {}",
                expected_workspace_id, workspace_id
            ));
        }
        if let Some(generation) = expected_generation {
            if session.generation != generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(())
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// Write into the PTY and observe the write according to its origin.
    /// User writes feed the bounded input tracker (a task is registered only
    /// when Enter commits a reliable line); Jarvis writes are registered by
    /// the caller with the exact text after this call succeeds.
    async fn write_typed_inner(
        &self,
        app: &AppHandle,
        id: &str,
        expected_runtime: Option<(&str, u64, Option<u32>)>,
        operation_id: Option<&str>,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if let Some((expected_workspace_id, expected_generation, expected_process_id)) =
            expected_runtime
        {
            let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
            if workspace_id != expected_workspace_id {
                return Err(format!(
                    "stale-terminal-workspace: expected {}, current {}",
                    expected_workspace_id, workspace_id
                ));
            }
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        if let Some(operation_id) = operation_id {
            if operation_id.is_empty()
                || operation_id.len() > 512
                || !operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b":-_.".contains(&byte))
            {
                return Err("invalid-input-operation-id".to_string());
            }
            if let Some(previous) = session.previous_input_operation(operation_id, data)? {
                return previous;
            }
        }

        if let Err(error) = session.write(data) {
            if let Some(operation_id) = operation_id {
                session.record_input_operation(operation_id.to_string(), data, Err(error.clone()));
            }
            return Err(error);
        }
        if let Some(operation_id) = operation_id {
            session.record_input_operation(operation_id.to_string(), data, Ok(()));
        }
        let command_detections = session.observe_agent_commands(data);
        let mut backend_identity_promoted = false;
        for detection in command_detections {
            let detection = promote_backend_launch_detection(
                origin,
                session.backend_agent_launch_state.as_deref(),
                session.agent_id.as_deref(),
                detection,
            );
            backend_identity_promoted |= detection.source == "backend-launch";
            if detection.source == "backend-launch" {
                apply_backend_launch_identity(&mut session, &detection);
            } else {
                apply_runtime_identity(&mut session, &detection);
            }
        }
        let agent_snapshot = snapshot_from_session(&session);

        // If the CWD was updated by a cd command detection, notify the frontend.
        if session.cwd_changed.swap(false, Ordering::Acquire) {
            let cwd = session
                .cwd
                .lock()
                .map(|cwd| cwd.clone())
                .unwrap_or_default();
            let _ = app.emit(
                "terminal-cwd-changed",
                TerminalCwdChanged {
                    terminal_id: id.to_string(),
                    workspace_id: agent_snapshot.workspace_id.clone(),
                    generation: agent_snapshot.generation,
                    process_id: agent_snapshot.process_id,
                    cwd,
                },
            );
        }

        drop(session);
        if agent_snapshot.is_agent_terminal {
            match origin {
                TerminalInputOrigin::User => notify_agent_user_input(&app, &agent_snapshot, data),
                TerminalInputOrigin::JarvisAbort => {
                    notify_agent_abort(&app, &agent_snapshot);
                }
                TerminalInputOrigin::Internal if backend_identity_promoted => {
                    // Backend-owned launches are authoritative: publish the
                    // trusted identity immediately so a concurrent reconcile
                    // cannot block Jarvis' first prompt on manual confirmation.
                    notify_agent_started(&app, &agent_snapshot);
                }
                TerminalInputOrigin::JarvisPrompt | TerminalInputOrigin::Internal => {
                    // Jarvis tasks are registered by chat.rs only after this
                    // call succeeds, with the exact validated text.
                }
            }
        }
        Ok(())
    }

    pub async fn write_typed_for_generation(
        &self,
        app: &AppHandle,
        id: &str,
        expected_generation: u64,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        let runtime = self.runtime_identity(id).await?;
        if runtime.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, runtime.generation
            ));
        }
        self.write_typed_inner(
            app,
            id,
            Some((
                &runtime.workspace_id,
                expected_generation,
                runtime.process_id,
            )),
            None,
            data,
            origin,
        )
        .await
    }

    pub async fn write_typed_for_runtime(
        &self,
        app: &AppHandle,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
        operation_id: Option<&str>,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        self.write_typed_inner(
            app,
            id,
            Some((
                expected_workspace_id,
                expected_generation,
                expected_process_id,
            )),
            operation_id,
            data,
            origin,
        )
        .await
    }

    pub async fn resize_generation(
        &self,
        id: &str,
        expected_generation: u64,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if session.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, session.generation
            ));
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        session.resize(cols, rows)
    }

    pub async fn kill_generation(
        &self,
        app: &AppHandle,
        id: &str,
        expected_generation: u64,
    ) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        let expected_session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let current_generation = expected_session.read().await.generation;
        if current_generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, current_generation
            ));
        }
        let removed = self
            .sessions
            .remove_if(id, |_, current| Arc::ptr_eq(current, &expected_session))
            .ok_or_else(|| "stale-terminal-generation: session was replaced".to_string())?;
        self.finish_removed_session(app, id, removed.1).await
    }

    /// Close the runtime half of a workspace before its persisted definition is
    /// deleted. The closing marker and session selection share the same short
    /// lifecycle gate as `spawn`, making the cutover deterministic: a spawn is
    /// either selected by this sweep or rejected as `workspace-closing`.
    pub async fn shutdown_workspace(
        &self,
        app: &AppHandle,
        workspace_id: &str,
    ) -> Result<usize, String> {
        let lifecycle = self.workspace_lifecycle.lock().await;
        self.closing_workspaces.insert(workspace_id.to_string());

        let candidates = self
            .sessions
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut removed = Vec::new();
        for (terminal_id, session) in candidates {
            let owns_workspace = session
                .read()
                .await
                .workspace_id
                .as_deref()
                .is_some_and(|candidate| candidate == workspace_id);
            if !owns_workspace {
                continue;
            }
            if let Some((_, session)) = self
                .sessions
                .remove_if(&terminal_id, |_, current| Arc::ptr_eq(current, &session))
            {
                removed.push((terminal_id, session));
            }
        }
        drop(lifecycle);

        let removed_count = removed.len();
        let mut first_error = None;
        for (terminal_id, session) in removed {
            if let Err(error) = self
                .finish_removed_session(app, &terminal_id, session)
                .await
            {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(removed_count),
        }
    }

    /// Commit the persistent half of an exact terminal close while `spawn`
    /// shares this lifecycle gate. A replacement generation that appeared
    /// after `kill_generation` aborts the commit, so an old close can never
    /// remove the configuration that now owns a new PTY lifetime.
    pub async fn commit_terminal_close(
        &self,
        registry: &crate::workspace::registry::WorkspaceRegistry,
        terminal_id: &str,
        workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<crate::workspace::registry::WorkspaceConfig, String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        self.ensure_workspace_accepts_spawns(workspace_id)?;

        if let Some(entry) = self.sessions.get(terminal_id) {
            let session = entry.value().clone();
            drop(entry);
            let session = session.read().await;
            return Err(format!(
                "terminal-close-race: expected generation {expected_generation} process {:?}, current generation {} process {:?}",
                expected_process_id, session.generation, session.process_id,
            ));
        }

        registry
            .remove_terminal_and_save(workspace_id, terminal_id)
            .await?
            .ok_or_else(|| "workspace non disponibile".to_string())
    }

    /// Re-open the spawn gate only when a failed deletion was rolled back or a
    /// workspace with the same explicit id was successfully created again.
    pub fn allow_workspace_spawns(&self, workspace_id: &str) {
        self.closing_workspaces.remove(workspace_id);
    }

    fn ensure_workspace_accepts_spawns(&self, workspace_id: &str) -> Result<(), String> {
        if !workspace_id.is_empty() && self.closing_workspaces.contains(workspace_id) {
            return Err(format!("workspace-closing: {workspace_id}"));
        }
        Ok(())
    }

    async fn finish_removed_session(
        &self,
        app: &AppHandle,
        id: &str,
        session_arc: Arc<RwLock<TerminalSession>>,
    ) -> Result<(), String> {
        let mut session = session_arc.write().await;
        let mut agent_snapshot = snapshot_from_session(&session);
        if let Err(error) = session.kill() {
            drop(session);
            let restored = match self.sessions.entry(id.to_string()) {
                Entry::Vacant(entry) => {
                    entry.insert(Arc::clone(&session_arc));
                    true
                }
                Entry::Occupied(entry) => Arc::ptr_eq(entry.get(), &session_arc),
            };
            warn!(
                terminal_id = %id,
                error_code = "terminal-kill-failed",
                restored,
                error = %error,
                "Terminal kill failed; runtime session retained for retry"
            );
            return if restored {
                Err(format!("terminal-kill-failed: {error}"))
            } else {
                Err(format!("terminal-kill-rollback-collision: {error}"))
            };
        }
        agent_snapshot.process_alive = false;
        drop(session);
        self.scheduler.lock().await.stop(id);

        let mut active = self.active_id.lock().await;
        if active.as_deref() == Some(id) {
            *active = None;
        }

        if agent_snapshot.is_agent_terminal {
            notify_agent_exit(app, &agent_snapshot);
        }

        info!(terminal_id = %id, "Terminal killed and removed");
        Ok(())
    }

    /// Kill every live session — used on app exit so no ConPTY/shell orphans remain.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        if ids.is_empty() {
            return;
        }
        info!(
            count = ids.len(),
            "Killing all terminal sessions on shutdown"
        );
        for id in ids {
            if let Some((_, session_arc)) = self.sessions.remove(&id) {
                let mut session = session_arc.write().await;
                if let Err(error) = session.kill() {
                    drop(session);
                    self.sessions.insert(id.clone(), session_arc);
                    warn!(
                        terminal_id = %id,
                        error_code = "terminal-kill-failed",
                        error = %error,
                        "Terminal remained registered after shutdown kill failure"
                    );
                }
            }
            self.scheduler.lock().await.stop(&id);
        }
        *self.active_id.lock().await = None;
        self.scheduler.lock().await.stop_all();
    }

    pub async fn set_active(&self, app: &AppHandle, id: Option<&str>) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        // Validate and recover the target before changing either active marker.
        // A failed spawn must leave the previous terminal active.
        if let Some(new_id) = id {
            if !self.sessions.contains_key(new_id) {
                return Err(format!("Terminal {} not found", new_id));
            }
            self.spawn_shell(app, new_id).await?;
        }

        let mut active = self.active_id.lock().await;
        if active.as_deref() == id {
            return Ok(());
        }
        let prev = active.clone();
        *active = id.map(str::to_owned);
        drop(active);

        if let Some(prev_id) = prev {
            if Some(prev_id.as_str()) != id {
                if let Some(session) = self
                    .sessions
                    .get(&prev_id)
                    .map(|entry| entry.value().clone())
                {
                    session.write().await.active = false;
                }
            }
        }
        if let Some(new_id) = id {
            if let Some(session) = self.sessions.get(new_id).map(|entry| entry.value().clone()) {
                session.write().await.active = true;
            }
        }

        info!(terminal_id = ?id, "Active terminal set");
        Ok(())
    }

    /// Activate only the exact PTY lifetime named by the frontend. The
    /// identity is rechecked while the target session is locked so a delayed
    /// focus callback cannot activate a replacement that reused the same id.
    pub async fn set_active_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
    ) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        let target = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        {
            let mut session = target.write().await;
            if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
                || session.generation != generation
                || session.process_id != process_id
            {
                return Err("stale-terminal-generation: active target changed".to_string());
            }
            let current = self
                .sessions
                .get(id)
                .map(|entry| Arc::ptr_eq(entry.value(), &target))
                .unwrap_or(false);
            if !current {
                return Err("stale-terminal-generation: session was replaced".to_string());
            }
            if !session.process_alive.load(Ordering::Acquire) {
                return Err(format!("terminal-exited: {id}"));
            }
            session.active = true;
        }

        let mut active = self.active_id.lock().await;
        if active.as_deref() == Some(id) {
            return Ok(());
        }
        let previous = active.replace(id.to_string());
        drop(active);
        if let Some(previous_id) = previous.filter(|previous_id| previous_id != id) {
            if let Some(session) = self
                .sessions
                .get(&previous_id)
                .map(|entry| entry.value().clone())
            {
                session.write().await.active = false;
            }
        }
        info!(terminal_id = %id, generation, process_id = ?process_id, "Active terminal lifetime set");
        Ok(())
    }

    /// Formatted scrollback, visible screen, parser modes, geometry, and the
    /// output watermark for rehydrating xterm after a workspace switch while
    /// the PTY remains alive.
    pub async fn get_state_for_rehydrate(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: Option<u64>,
        expected_process_id: Option<u32>,
    ) -> Result<TerminalRehydrateState, String> {
        self.validate_rehydrate_scope(
            id,
            expected_workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await?;
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;

        let session = session_arc.read().await;
        if let Some(expected_generation) = expected_generation {
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }

        let mut parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let history = parser.scrollback_text_for_rehydrate();
        let state = parser.state_for_rehydrate();
        let output_sequence = session.output_sequence.load(Ordering::Acquire);
        Ok(TerminalRehydrateState {
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            generation: session.generation,
            process_id: session.process_id,
            history,
            state,
            output_sequence,
            cols: session.grid.cols,
            rows: session.grid.rows,
        })
    }

    pub async fn get_agent_snapshot(
        &self,
        id: &str,
    ) -> Result<Option<TerminalAgentSnapshot>, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(Some(snapshot_from_session(&session)))
    }

    pub async fn observe_agent_provider_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        provider: &str,
        source: &str,
        confidence: f32,
    ) -> Result<(), String> {
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let mut session = session_arc.write().await;
        if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
            || session.generation != generation
            || session.process_id != process_id
        {
            return Err("stale-terminal-generation: provider target changed".to_string());
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        apply_observed_provider(&mut session, provider, source, confidence);
        Ok(())
    }

    pub async fn get_recent_normalized_terminal_text_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        max_bytes: usize,
    ) -> Result<NormalizedTerminalText, String> {
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let session = session_arc.read().await;
        let mut parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let text = parser.recent_normalized_text();
        drop(parser);
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        bounded_terminal_text(&text, max_bytes)
    }

    pub async fn list_agent_snapshots(&self) -> Vec<TerminalAgentSnapshot> {
        let sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut snapshots = Vec::new();
        for session in sessions {
            let session = session.read().await;
            if session.is_agent_terminal {
                snapshots.push(snapshot_from_session(&session));
            }
        }
        snapshots.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
        snapshots
    }

    pub async fn get_snapshot(
        &self,
        id: &str,
        expected_generation: u64,
    ) -> Result<FrameSnapshot, String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
        if session.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, session.generation
            ));
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }

        let rows = session.grid.rows;
        let cols = session.grid.cols;
        let mut cells = Vec::new();

        if let Ok(p) = session.parser.lock() {
            let screen = p.screen();
            for r in 0..rows {
                let mut row = Vec::new();
                for c in 0..cols {
                    if let Some(vt_cell) = screen.cell(r, c) {
                        row.push(convert_vt_cell(vt_cell));
                    } else {
                        row.push(Cell::default());
                    }
                }
                cells.push(row);
            }
        } else {
            for _ in 0..rows {
                let mut row = Vec::new();
                for _ in 0..cols {
                    row.push(Cell::default());
                }
                cells.push(row);
            }
        }

        let cursor_pos = if let Ok(p) = session.parser.lock() {
            let (cr, cc) = p.screen().cursor_position();
            crate::terminal_engine::frame::CursorPosition { row: cr, col: cc }
        } else {
            session.grid.cursor.clone()
        };

        let title = if let Ok(p) = session.parser.lock() {
            p.screen().title().to_string()
        } else {
            session.grid.title.clone()
        };

        Ok(FrameSnapshot {
            terminal_id: id.to_string(),
            cols,
            rows,
            cells,
            cursor: cursor_pos,
            cursor_visible: true,
            title,
        })
    }

    pub async fn get_scrollback(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<Vec<Cell>>, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(session.grid.get_scrollback(offset, limit))
    }

    /// Returns the current git branch name for the terminal's working directory.
    /// Runs `git -C <cwd> branch --show-current` and returns Some(branch) if
    /// the directory is a git repository, or None otherwise.
    /// Errors only if the terminal session doesn't exist.
    pub async fn get_git_branch(&self, id: &str) -> Result<Option<String>, String> {
        let cwd = self.get_terminal_cwd(id).await?;
        self.get_git_branch_for_cwd(id, &cwd).await
    }

    /// Returns a CWD and its branch from the same backend snapshot.
    pub async fn get_terminal_context_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
    ) -> Result<TerminalContext, String> {
        let session = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let cwd = {
            let session = session.read().await;
            session
                .cwd
                .lock()
                .map(|cwd| cwd.clone())
                .map_err(|_| format!("Terminal {} CWD lock poisoned", id))?
        };
        let git_branch = self.get_git_branch_for_cwd(id, &cwd).await?;
        self.session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        Ok(TerminalContext { cwd, git_branch })
    }

    /// Synchronizes the tracked CWD with the shell prompt rendered in xterm.
    /// This covers PowerShell tab completion, whose completed path never passes
    /// back through the PTY input stream as literal keystrokes.
    pub async fn sync_terminal_cwd_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        cwd: &str,
    ) -> Result<TerminalContext, String> {
        let canonical = std::path::Path::new(cwd)
            .canonicalize()
            .map_err(|error| format!("Could not resolve terminal CWD: {error}"))?;
        if !canonical.is_dir() {
            return Err("Terminal CWD is not a directory".to_string());
        }
        let normalized = canonical
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .trim_start_matches("\\\\.\\")
            .to_string();
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        {
            let session = session_arc.read().await;
            if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
                || session.generation != generation
                || session.process_id != process_id
            {
                return Err("stale-terminal-generation: CWD target changed".to_string());
            }
            let current_session = self
                .sessions
                .get(id)
                .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
                .unwrap_or(false);
            if !current_session {
                return Err("stale-terminal-generation: session was replaced".to_string());
            }
            let mut current = session
                .cwd
                .lock()
                .map_err(|_| format!("Terminal {} CWD lock poisoned", id))?;
            if *current != normalized {
                info!(terminal_id = %id, generation, from = %current, to = %normalized, "Terminal CWD synchronized from exact PowerShell runtime");
                *current = normalized.clone();
            }
        }
        let git_branch = self.get_git_branch_for_cwd(id, &normalized).await?;
        self.session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        Ok(TerminalContext {
            cwd: normalized,
            git_branch,
        })
    }

    async fn get_terminal_cwd(&self, id: &str) -> Result<String, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        session
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .map_err(|_| format!("Terminal {} CWD lock poisoned", id))
    }

    async fn get_git_branch_for_cwd(&self, id: &str, cwd: &str) -> Result<Option<String>, String> {
        info!(terminal_id = %id, cwd = %cwd, "get_git_branch: checking");

        let mut git_command = tokio::process::Command::new("git");
        git_command
            .args(["-C", cwd, "branch", "--show-current"])
            // This probe must never inherit an interactive terminal: it is a
            // metadata lookup for the title bar, not a user-facing command.
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV)
            .env_remove(crate::settings::secrets::GROQ_API_KEY_ENV)
            .env("GIT_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never");

        // The release app is a Windows GUI process without a console. Without
        // CREATE_NO_WINDOW, every background `git` probe can create a visible
        // console window when the user changes directory or workspace.
        #[cfg(windows)]
        git_command.creation_flags(0x08000000);

        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), git_command.output()).await;

        let output = match result {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                info!(terminal_id = %id, cwd = %cwd, error = %e, "get_git_branch: spawn error");
                return Ok(None);
            }
            Err(_) => {
                info!(terminal_id = %id, cwd = %cwd, "get_git_branch: timed out after 5s");
                return Ok(None);
            }
        };

        if output.status.success() {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            info!(
                terminal_id = %id,
                cwd = %cwd,
                branch = %branch,
                "get_git_branch: success"
            );
            Ok(if branch.is_empty() {
                None
            } else {
                Some(branch)
            })
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            info!(
                terminal_id = %id,
                cwd = %cwd,
                git_exit = %output.status,
                git_stderr = %stderr,
                "get_git_branch: git failed"
            );
            Ok(None)
        }
    }

    pub fn start_event_loop(&self, app: AppHandle) {
        info!("Terminal manager event loop ready");
        if self
            .detector_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        #[cfg(windows)]
        tauri::async_runtime::spawn(async move {
            loop {
                let manager = app.state::<TerminalManager>();
                let targets = manager.process_detection_targets().await;
                let root_pids = targets
                    .iter()
                    .map(|(_, _, pid, _)| *pid)
                    .collect::<Vec<_>>();
                match scan_process_tree_async(root_pids).await {
                    Ok(scan) => {
                        manager.apply_process_detections(targets, scan, &app).await;
                    }
                    Err(error) => {
                        warn!(%error, "Agent process-tree scan unavailable; liveness unchanged");
                    }
                }
                let retry_fast = manager
                    .process_detection_targets()
                    .await
                    .iter()
                    .any(|(_, _, _, source)| identity_source_priority(source) < 4);
                tokio::time::sleep(std::time::Duration::from_secs(if retry_fast {
                    3
                } else {
                    10
                }))
                .await;
            }
        });

        #[cfg(not(windows))]
        {
            let _ = app;
        }
    }

    #[cfg(windows)]
    async fn process_detection_targets(&self) -> Vec<(String, u64, u32, String)> {
        let sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut targets = Vec::new();
        for session in sessions {
            let session = session.read().await;
            if !session.process_alive.load(Ordering::Acquire)
                || session.process_id.is_none()
                || (!session.is_agent_terminal
                    && session.agent_id.is_none()
                    && session.observed_provider.is_none()
                    && session.agent_runtime_presence.alive().is_none())
            {
                continue;
            }
            targets.push((
                session.id.clone(),
                session.generation,
                session.process_id.unwrap_or_default(),
                session.detection_source.clone(),
            ));
        }
        targets
    }

    #[cfg(windows)]
    async fn apply_process_detections(
        &self,
        targets: Vec<(String, u64, u32, String)>,
        scan: crate::jarvis::runtime_detector::ProcessTreeScan,
        app: &AppHandle,
    ) {
        for (terminal_id, generation, pid, _) in targets {
            let Some(session_arc) = self
                .sessions
                .get(&terminal_id)
                .map(|entry| entry.value().clone())
            else {
                continue;
            };
            let mut session = session_arc.write().await;
            let current = self
                .sessions
                .get(&terminal_id)
                .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
                .unwrap_or(false);
            if session.generation == generation
                && session.process_id == Some(pid)
                && session.process_alive.load(Ordering::Acquire)
                && current
            {
                if let Some(detection) = scan.detections.get(&pid) {
                    let presence_transition = session.agent_runtime_presence.observed();
                    let identity_changed = session.observed_provider.as_deref()
                        != Some(detection.provider.as_str())
                        || session.detection_source != detection.source
                        || !session.is_agent_terminal;
                    apply_runtime_identity(&mut session, detection);
                    if presence_transition == AgentPresenceTransition::BecameActive
                        || identity_changed
                    {
                        let snapshot = snapshot_from_session(&session);
                        drop(session);
                        notify_agent_started(app, &snapshot);
                    }
                } else if scan.roots_with_candidate_descendants.contains(&pid) {
                    if let Some(provider) = candidate_descendant_provider(&session) {
                        let transition = session.agent_runtime_presence.observed();
                        if transition == AgentPresenceTransition::BecameActive {
                            apply_runtime_identity(
                                &mut session,
                                &AgentDetection {
                                    provider,
                                    source: "process-tree".to_string(),
                                    confidence: 0.9,
                                },
                            );
                            let snapshot = snapshot_from_session(&session);
                            drop(session);
                            notify_agent_started(app, &snapshot);
                        }
                    }
                } else if session.agent_runtime_presence.missed()
                    == AgentPresenceTransition::BecameInactive
                {
                    session.is_agent_terminal = false;
                    session.observed_provider = None;
                    session.backend_agent_launch_state = None;
                    session.detection_source = "agent-process-exited".to_string();
                    session.detection_confidence = 0.9;
                    let snapshot = snapshot_from_session(&session);
                    drop(session);
                    notify_agent_exit(app, &snapshot);
                }
            }
        }
    }

    #[allow(dead_code)]
    pub async fn start_frame_scheduler(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        self.scheduler
            .lock()
            .await
            .start(app, session, id.to_string())
            .await;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn stop_frame_scheduler(&self, id: &str) {
        self.scheduler.lock().await.stop(id);
    }
}

fn snapshot_from_session(session: &TerminalSession) -> TerminalAgentSnapshot {
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
    }
}

fn promote_backend_launch_detection(
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

fn candidate_descendant_provider(session: &TerminalSession) -> Option<String> {
    session.observed_provider.clone().or_else(|| {
        matches!(
            session.backend_agent_launch_state.as_deref(),
            Some("starting" | "ready")
        )
        .then(|| session.agent_id.as_deref().and_then(normalize_provider))
        .flatten()
    })
}

fn apply_backend_launch_identity(session: &mut TerminalSession, detection: &AgentDetection) {
    apply_runtime_identity_with_presence(session, detection, false);
}

fn apply_runtime_identity(session: &mut TerminalSession, detection: &AgentDetection) {
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

fn apply_observed_provider(
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

fn bounded_terminal_text(text: &str, max_bytes: usize) -> Result<NormalizedTerminalText, String> {
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

fn ensure_spawn_workspace_matches(
    current_workspace_id: Option<&str>,
    requested_workspace_id: &str,
) -> Result<(), String> {
    if current_workspace_id.unwrap_or_default() != requested_workspace_id {
        return Err(
            "terminal-workspace-mismatch: existing PTY belongs to another workspace".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{
        apply_backend_launch_identity, candidate_descendant_provider,
        ensure_spawn_workspace_matches, promote_backend_launch_detection, TerminalInputOrigin,
        TerminalManager, TerminalSession,
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

fn notify_agent_started(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_terminal_started(snapshot, &chrono::Utc::now().to_rfc3339());
    }
    emit_agent_registry_changed(app, snapshot, "started");
}

fn notify_agent_user_input(app: &AppHandle, snapshot: &TerminalAgentSnapshot, data: &[u8]) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        let observed_at = chrono::Utc::now().to_rfc3339();
        state
            .registry
            .observe_user_input(snapshot, data, &observed_at);
        state
            .registry
            .observe_user_typing(snapshot, data, &observed_at);
    }
    // Typing alone does not change the user-visible lifecycle. Refresh only
    // after a committed line to avoid an IPC/context refresh per keystroke.
    if data.iter().any(|byte| matches!(byte, b'\r' | b'\n')) {
        emit_agent_registry_changed(app, snapshot, "input_committed");
    }
}

fn notify_agent_abort(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_abort(snapshot, &chrono::Utc::now().to_rfc3339());
    }
    emit_agent_registry_changed(app, snapshot, "interrupted");
}

fn notify_agent_exit(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state.registry.observe_terminal_exit(
            &snapshot.terminal_id,
            snapshot.generation,
            &chrono::Utc::now().to_rfc3339(),
        );
    }
    emit_agent_registry_changed(app, snapshot, "exited");
}

fn emit_agent_registry_changed(app: &AppHandle, snapshot: &TerminalAgentSnapshot, reason: &str) {
    let _ = app.emit(
        "jarvis://agent-registry-changed",
        serde_json::json!({
            "workspaceId": snapshot.workspace_id,
            "terminalId": snapshot.terminal_id,
            "generation": snapshot.generation,
            "reason": reason,
        }),
    );
}

fn convert_vt_cell(vt_cell: &vt100::Cell) -> Cell {
    Cell {
        ch: vt_cell.contents().chars().next().unwrap_or(' '),
        fg: convert_vt_color(&vt_cell.fgcolor()),
        bg: convert_vt_color(&vt_cell.bgcolor()),
        bold: vt_cell.bold(),
        italic: vt_cell.italic(),
        underline: vt_cell.underline(),
        inverse: vt_cell.inverse(),
    }
}

fn convert_vt_color(color: &vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::new(204, 204, 204),
        vt100::Color::Idx(idx) => idx_to_rgb(*idx),
        vt100::Color::Rgb(r, g, b) => Color::new(*r, *g, *b),
    }
}

fn idx_to_rgb(idx: u8) -> Color {
    if idx < 16 {
        Color::new(
            ANSI_COLORS[idx as usize][0],
            ANSI_COLORS[idx as usize][1],
            ANSI_COLORS[idx as usize][2],
        )
    } else if idx < 232 {
        let n = (idx - 16) as u16;
        let r = ((n / 36) * 255 / 5) as u8;
        let g = (((n % 36) / 6) * 255 / 5) as u8;
        let b = ((n % 6) * 255 / 5) as u8;
        Color::new(r, g, b)
    } else {
        let gray = (idx - 232) * 255 / 23;
        Color::new(gray, gray, gray)
    }
}

const ANSI_COLORS: [[u8; 3]; 16] = [
    [0, 0, 0],       // Black
    [205, 49, 49],   // Red
    [13, 188, 121],  // Green
    [229, 229, 16],  // Yellow
    [36, 114, 200],  // Blue
    [188, 63, 188],  // Magenta
    [17, 168, 205],  // Cyan
    [229, 229, 229], // White
    [102, 102, 102], // BrightBlack
    [241, 76, 76],   // BrightRed
    [35, 209, 139],  // BrightGreen
    [245, 245, 67],  // BrightYellow
    [59, 142, 234],  // BrightBlue
    [214, 112, 214], // BrightMagenta
    [41, 184, 219],  // BrightCyan
    [229, 229, 229], // BrightWhite
];
