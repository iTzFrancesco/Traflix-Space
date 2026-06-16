use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tracing::warn;

use crate::terminal_engine::session::TerminalSession;
use crate::terminal_engine::frame::FrameDiff;

pub struct FrameScheduler {
    active_interval: Duration,
    inactive_interval: Duration,
}

impl FrameScheduler {
    pub fn new() -> Self {
        Self {
            active_interval: Duration::from_millis(16),
            inactive_interval: Duration::from_millis(500),
        }
    }

    pub fn start(&self, app: AppHandle, session: Arc<RwLock<TerminalSession>>) {
        let active_interval = self.active_interval;
        let inactive_interval = self.inactive_interval;

        tokio::spawn(async move {
            let mut frame_count: u64 = 0;
            loop {
                let is_active = {
                    let s = session.read().await;
                    s.active
                };

                let sleep_duration = if is_active {
                    active_interval
                } else {
                    inactive_interval
                };

                tokio::time::sleep(sleep_duration).await;

                let snapshot_opt = {
                    let s = session.read().await;
                    if s.grid.cells.is_empty() {
                        continue;
                    }
                    let snapshot = s.grid.snapshot(&s.id);
                    let diff = FrameDiff {
                        terminal_id: s.id.clone(),
                        cursor: snapshot.cursor.clone(),
                        cursor_visible: true,
                        title: if snapshot.title.is_empty() { None } else { Some(snapshot.title.clone()) },
                        dirty_cells: Vec::new(),
                        scrolled_lines: 0,
                        clear_screen: frame_count == 0,
                    };
                    frame_count += 1;
                    diff
                };

                if let Err(e) = app.emit("terminal-frame", snapshot_opt) {
                    warn!("Error emitting terminal frame: {}", e);
                    break;
                }
            }
        });
    }

    pub fn stop(&self, _terminal_id: &str) {
    }
}
