use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::terminal_engine::frame::{CellUpdate, FrameDiff};
use crate::terminal_engine::session::TerminalSession;

pub struct FrameScheduler {
    inactive_interval: Duration,
    tokens: HashMap<String, CancellationToken>,
}

impl FrameScheduler {
    pub fn new() -> Self {
        Self {
            inactive_interval: Duration::from_millis(500),
            tokens: HashMap::new(),
        }
    }

    pub async fn start(
        &mut self,
        app: AppHandle,
        session: Arc<RwLock<TerminalSession>>,
        id: String,
    ) {
        self.stop(&id);

        let token = CancellationToken::new();
        let child_token = token.child_token();
        self.tokens.insert(id.clone(), token);

        let inactive_interval = self.inactive_interval;

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = child_token.cancelled() => {
                        break;
                    }
                    _ = tokio::time::sleep(inactive_interval) => {
                        let snapshot_opt = {
                            let s = session.read().await;

                            if s.active {
                                continue;
                            }

                            let cursor = s.grid.cursor.clone();
                            let mut title = None;
                            let id = s.id.clone();

                            let result = if let Ok(p) = s.parser.lock() {
                                let screen = p.screen();
                                let rows = s.grid.rows;
                                let cols = s.grid.cols;

                                let t = screen.title();
                                if !t.is_empty() {
                                    title = Some(t.to_string());
                                }

                                let mut dirty_cells = Vec::new();
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

                                Some(FrameDiff {
                                    terminal_id: id,
                                    cursor,
                                    cursor_visible: true,
                                    title,
                                    dirty_cells,
                                    scrolled_lines: 0,
                                    clear_screen: false,
                                })
                            } else {
                                None
                            };

                            result
                        };

                        if let Some(diff) = snapshot_opt {
                            if let Err(e) = app.emit("terminal-frame", diff) {
                                warn!("Error emitting terminal frame: {}", e);
                                break;
                            }
                        }
                    }
                }
            }
        });
    }

    pub fn stop(&mut self, terminal_id: &str) {
        if let Some(token) = self.tokens.remove(terminal_id) {
            token.cancel();
        }
    }

    pub fn stop_all(&mut self) {
        for (_, token) in self.tokens.drain() {
            token.cancel();
        }
    }
}
