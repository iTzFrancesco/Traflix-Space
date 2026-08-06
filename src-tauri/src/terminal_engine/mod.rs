mod cell;
pub(crate) mod commands;
mod frame;
mod grid;
mod parser;
mod scheduler;
mod session;

pub use cell::{Cell, Color};
pub use frame::{FrameSnapshot, TerminalRehydrateState};
pub use session::TerminalSession;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tracing::info;

use crate::terminal_engine::scheduler::FrameScheduler;

pub use crate::jarvis::agent_registry::{NormalizedTerminalText, TerminalAgentSnapshot};

pub struct TerminalManager {
    pub sessions: DashMap<String, Arc<RwLock<TerminalSession>>>,
    scheduler: tokio::sync::Mutex<FrameScheduler>,
    /// Currently focused terminal id (avoids write-locking every session on set_active).
    active_id: tokio::sync::Mutex<Option<String>>,
    next_generation: AtomicU64,
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
    cwd: String,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            scheduler: tokio::sync::Mutex::new(FrameScheduler::new()),
            active_id: tokio::sync::Mutex::new(None),
            next_generation: AtomicU64::new(1),
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
        let initial_cols = cols.max(1);
        let initial_rows = rows.max(1);

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
                    let mut session =
                        TerminalSession::new(id.clone(), shell, cwd, initial_cols, initial_rows);
                    session.generation = generation;
                    session.is_agent_terminal = config.agent_id.is_some();
                    session.agent_id = config.agent_id.clone();
                    session.workspace_id = config.workspace_id.clone();
                    slot.insert(Arc::new(RwLock::new(session)));
                    info!(terminal_id = %id, "Terminal session created");
                    break;
                }
            }
        }

        // Spawn the shell immediately so the PTY reader starts sending output.
        // If spawn fails, remove the empty session to avoid zombies in the map.
        if let Err(e) = self.spawn_shell(&app, &id).await {
            let _ = self.sessions.remove(&id);
            return Err(e);
        }

        if let Some(snapshot) = self.get_agent_snapshot(&id).await.ok().flatten() {
            if snapshot.is_agent_terminal {
                notify_agent_started(&app, &snapshot);
            }
        }

        Ok(id)
    }

    pub async fn spawn_shell(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.write().await;
        if session.pty.is_some() {
            return Ok(());
        }
        session.spawn(app.clone()).await?;
        info!(terminal_id = %id, "Shell spawned");
        Ok(())
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    pub async fn write(&self, app: &AppHandle, id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        session.write(data)?;
        let agent_snapshot = TerminalAgentSnapshot {
            terminal_id: session.id.clone(),
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            is_agent_terminal: session.agent_id.is_some(),
            agent_id: session.agent_id.clone(),
            generation: session.generation,
            process_alive: session.process_alive.load(Ordering::Acquire),
        };

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
                    cwd,
                },
            );
        }

        drop(session);
        if agent_snapshot.is_agent_terminal {
            notify_agent_input(&app, &agent_snapshot);
        }
        Ok(())
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.write().await;
        session.resize(cols, rows)?;
        Ok(())
    }

    pub async fn kill(&self, _app: &AppHandle, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .remove(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.1.write().await;
        let agent_snapshot = TerminalAgentSnapshot {
            terminal_id: session.id.clone(),
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            is_agent_terminal: session.agent_id.is_some(),
            agent_id: session.agent_id.clone(),
            generation: session.generation,
            process_alive: false,
        };
        session.kill();
        self.scheduler.lock().await.stop(id);

        let mut active = self.active_id.lock().await;
        if active.as_deref() == Some(id) {
            *active = None;
        }

        if agent_snapshot.is_agent_terminal {
            notify_agent_exit(_app, &agent_snapshot);
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
            if let Some((_, session)) = self.sessions.remove(&id) {
                let mut session = session.write().await;
                session.kill();
            }
            self.scheduler.lock().await.stop(&id);
        }
        *self.active_id.lock().await = None;
        self.scheduler.lock().await.stop_all();
    }

    pub async fn set_active(&self, app: &AppHandle, id: Option<&str>) -> Result<(), String> {
        // No-op when already active (short lock).
        {
            let active = self.active_id.lock().await;
            if active.as_deref() == id {
                return Ok(());
            }
        }

        // Snapshot previous id, then update flags without holding active_id
        // across session write locks longer than needed.
        let prev = {
            let mut active = self.active_id.lock().await;
            let prev = active.clone();
            *active = id.map(|s| s.to_string());
            prev
        };

        if let Some(ref prev_id) = prev {
            if Some(prev_id.as_str()) != id {
                if let Some(entry) = self.sessions.get(prev_id) {
                    let mut session = entry.write().await;
                    session.active = false;
                }
            }
        }

        if let Some(new_id) = id {
            if let Some(entry) = self.sessions.get(new_id) {
                let mut session = entry.write().await;
                session.active = true;
            }
            // Recovery path if spawn was missed.
            self.spawn_shell(app, new_id).await?;
        }

        info!(terminal_id = ?id, "Active terminal set");
        Ok(())
    }

    /// Formatted scrollback, visible screen, parser modes, geometry, and the
    /// output watermark for rehydrating xterm after a workspace switch while
    /// the PTY remains alive.
    pub async fn get_state_for_rehydrate(
        &self,
        id: &str,
    ) -> Result<TerminalRehydrateState, String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;

        let session = session.read().await;

        let mut parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let history = parser.scrollback_text_for_rehydrate();
        let state = parser.state_for_rehydrate();
        let output_sequence = session.output_sequence.load(Ordering::Acquire);
        Ok(TerminalRehydrateState {
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
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(session.is_agent_terminal.then(|| TerminalAgentSnapshot {
            terminal_id: session.id.clone(),
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            is_agent_terminal: true,
            agent_id: session.agent_id.clone(),
            generation: session.generation,
            process_alive: session.process_alive.load(Ordering::Acquire),
        }))
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
                snapshots.push(TerminalAgentSnapshot {
                    terminal_id: session.id.clone(),
                    workspace_id: session.workspace_id.clone().unwrap_or_default(),
                    is_agent_terminal: true,
                    agent_id: session.agent_id.clone(),
                    generation: session.generation,
                    process_alive: session.process_alive.load(Ordering::Acquire),
                });
            }
        }
        snapshots.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
        snapshots
    }

    pub async fn get_normalized_screen_text(
        &self,
        id: &str,
        max_bytes: usize,
    ) -> Result<NormalizedTerminalText, String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        let parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let text = parser.screen_text(session.grid.rows, session.grid.cols);
        let text = text.trim_end().to_string();
        if text.len() <= max_bytes {
            return Ok(NormalizedTerminalText {
                content: text,
                truncated: false,
            });
        }
        let mut start = text.len() - max_bytes;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        Ok(NormalizedTerminalText {
            content: text[start..].to_string(),
            truncated: true,
        })
    }

    pub async fn get_snapshot(&self, id: &str) -> Result<FrameSnapshot, String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;

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
    pub async fn get_terminal_context(&self, id: &str) -> Result<TerminalContext, String> {
        let cwd = self.get_terminal_cwd(id).await?;
        let git_branch = self.get_git_branch_for_cwd(id, &cwd).await?;
        Ok(TerminalContext { cwd, git_branch })
    }

    /// Synchronizes the tracked CWD with the shell prompt rendered in xterm.
    /// This covers PowerShell tab completion, whose completed path never passes
    /// back through the PTY input stream as literal keystrokes.
    pub async fn sync_terminal_cwd(&self, id: &str, cwd: &str) -> Result<TerminalContext, String> {
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

        {
            let session = self
                .sessions
                .get(id)
                .ok_or_else(|| format!("Terminal {} not found", id))?;
            let session = session.read().await;
            let mut current = session
                .cwd
                .lock()
                .map_err(|_| format!("Terminal {} CWD lock poisoned", id))?;
            if *current != normalized {
                info!(terminal_id = %id, from = %current, to = %normalized, "Terminal CWD synchronized from PowerShell prompt");
                *current = normalized.clone();
            }
        }

        let git_branch = self.get_git_branch_for_cwd(id, &normalized).await?;
        Ok(TerminalContext {
            cwd: normalized,
            git_branch,
        })
    }

    async fn get_terminal_cwd(&self, id: &str) -> Result<String, String> {
        let session = self
            .sessions
            .get(id)
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

    pub fn start_event_loop(&self, _app: AppHandle) {
        info!("Terminal manager event loop ready");
    }

    #[allow(dead_code)]
    pub async fn start_frame_scheduler(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        self.scheduler
            .lock()
            .await
            .start(app, session.value().clone(), id.to_string())
            .await;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn stop_frame_scheduler(&self, id: &str) {
        self.scheduler.lock().await.stop(id);
    }
}

fn notify_agent_started(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_terminal_started(snapshot, &chrono::Utc::now().to_rfc3339());
    }
}

fn notify_agent_input(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_input(snapshot, &chrono::Utc::now().to_rfc3339());
    }
}

fn notify_agent_exit(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state.registry.observe_terminal_exit(
            &snapshot.terminal_id,
            snapshot.generation,
            &chrono::Utc::now().to_rfc3339(),
        );
    }
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
