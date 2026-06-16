use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tracing::warn;

use crate::terminal_engine::session::TerminalSession;
use crate::terminal_engine::frame::{CellUpdate, FrameDiff};

pub struct FrameScheduler {
    inactive_interval: Duration,
}

impl FrameScheduler {
    pub fn new() -> Self {
        Self {
            inactive_interval: Duration::from_millis(500),
        }
    }

    pub fn start(&self, app: AppHandle, session: Arc<RwLock<TerminalSession>>) {
        let inactive_interval = self.inactive_interval;

        tokio::spawn(async move {
            loop {
                let snapshot_opt = {
                    let s = session.read().await;

                    if s.active {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }

                    let mut dirty_cells = Vec::new();
                    let cursor = s.grid.cursor.clone();
                    let mut title = None;

                    if let Ok(p) = s.parser.lock() {
                        let screen = p.screen();
                        let (cr, cc) = screen.cursor_position();
                        let rows = s.grid.rows;
                        let cols = s.grid.cols;

                        let t = screen.title();
                        if !t.is_empty() {
                            title = Some(t.to_string());
                        }

                        for r in 0..rows {
                            for c in 0..cols {
                                if let Some(vt_cell) = screen.cell(r, c) {
                                    dirty_cells.push(CellUpdate {
                                        row: r, col: c,
                                        cell: super::convert_vt_cell(vt_cell),
                                    });
                                }
                            }
                        }
                    }

                    Some(FrameDiff {
                        terminal_id: s.id.clone(),
                        cursor,
                        cursor_visible: true,
                        title,
                        dirty_cells,
                        scrolled_lines: 0,
                        clear_screen: false,
                    })
                };

                if let Some(diff) = snapshot_opt {
                    if let Err(e) = app.emit("terminal-frame", diff) {
                        warn!("Error emitting terminal frame: {}", e);
                        break;
                    }
                }

                tokio::time::sleep(inactive_interval).await;
            }
        });
    }

    pub fn stop(&self, _terminal_id: &str) {
    }
}
