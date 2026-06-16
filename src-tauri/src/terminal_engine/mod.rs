pub(crate) mod commands;
mod cell;
mod frame;
mod grid;
mod parser;
mod scheduler;
mod session;

pub use cell::Cell;
pub use frame::{CellUpdate, FrameDiff, FrameSnapshot};
pub use session::TerminalSession;

use dashmap::DashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::RwLock;
use tracing::info;

use crate::terminal_engine::scheduler::FrameScheduler;

pub struct TerminalManager {
    pub sessions: DashMap<String, Arc<RwLock<TerminalSession>>>,
    scheduler: FrameScheduler,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            scheduler: FrameScheduler::new(),
        }
    }

    pub async fn spawn(&self, _app: AppHandle, config: crate::workspace::registry::TerminalConfig) -> Result<String, String> {
        let id = config.id.clone();
        let shell = if config.shell.is_empty() {
            "powershell.exe".to_string()
        } else {
            config.shell.clone()
        };
        let cwd = if config.cwd.is_empty() {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        } else {
            config.cwd.clone()
        };

        let session = TerminalSession::new(
            id.clone(),
            shell,
            cwd,
            80,
            24,
        );

        self.sessions.insert(id.clone(), Arc::new(RwLock::new(session)));
        info!(terminal_id = %id, "Terminal session created");

        Ok(id)
    }

    pub async fn spawn_shell(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.write().await;
        if session.pty.is_some() {
            return Ok(());
        }
        session.spawn(app.clone()).await?;
        info!(terminal_id = %id, "Shell spawned");
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.try_read()
            .map_err(|_| "Terminal session locked".to_string())?;
        session.write(data)
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.write().await;
        session.resize(cols, rows);
        info!(terminal_id = %id, cols, rows, "Terminal resized");
        Ok(())
    }

    pub async fn kill(&self, _app: &AppHandle, id: &str) -> Result<(), String> {
        let session = self.sessions.remove(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.1.write().await;
        session.kill();
        self.scheduler.stop(id);
        info!(terminal_id = %id, "Terminal killed and removed");
        Ok(())
    }

    pub async fn set_active(&self, app: &AppHandle, id: Option<&str>) -> Result<(), String> {
        let mut active_id: Option<String> = None;
        for entry in self.sessions.iter() {
            let mut session = entry.value().write().await;
            if Some(entry.key().as_str()) == id {
                session.active = true;
                active_id = Some(entry.key().clone());
                self.scheduler.start(app.clone(), entry.value().clone());
            } else {
                session.active = false;
                self.scheduler.stop(entry.key());
            }
        }

        if let Some(ref aid) = active_id {
            self.spawn_shell(app, aid).await?;
        }

        info!(terminal_id = ?id, "Active terminal set");
        Ok(())
    }

    pub async fn get_snapshot(&self, id: &str) -> Result<FrameSnapshot, String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(session.grid.snapshot(id))
    }

    pub async fn get_scrollback(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<Vec<Cell>>, String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(session.grid.get_scrollback(offset, limit))
    }

    pub fn start_event_loop(&self, _app: AppHandle) {
        info!("Terminal manager event loop ready");
    }

    pub async fn start_frame_scheduler(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let session = self.sessions.get(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        self.scheduler.start(app, session.value().clone());
        Ok(())
    }

    pub async fn stop_frame_scheduler(&self, id: &str) {
        self.scheduler.stop(id);
    }
}
