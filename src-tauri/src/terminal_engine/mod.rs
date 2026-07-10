pub(crate) mod commands;
mod cell;
mod frame;
mod grid;
mod parser;
mod scheduler;
mod session;

pub use cell::{Cell, Color};
pub use frame::{CellUpdate, FrameDiff, FrameSnapshot, TerminalOutput};
pub use session::TerminalSession;

use dashmap::DashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::RwLock;
use tracing::info;

use crate::terminal_engine::scheduler::FrameScheduler;

pub struct TerminalManager {
    pub sessions: DashMap<String, Arc<RwLock<TerminalSession>>>,
    scheduler: tokio::sync::Mutex<FrameScheduler>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            scheduler: tokio::sync::Mutex::new(FrameScheduler::new()),
        }
    }

    pub async fn spawn(&self, app: AppHandle, config: crate::workspace::registry::TerminalConfig) -> Result<String, String> {
        let id = config.id.clone();
        if self.sessions.contains_key(&id) {
            info!(terminal_id = %id, "Terminal session already exists, reusing");
            return Ok(id);
        }
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

        // Spawn the shell immediately so the PTY reader starts sending output
        self.spawn_shell(&app, &id).await?;

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
        session.resize(cols, rows)?;
        info!(terminal_id = %id, cols, rows, "Terminal resized");
        Ok(())
    }

    pub async fn kill(&self, _app: &AppHandle, id: &str) -> Result<(), String> {
        let session = self.sessions.remove(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session.1.write().await;
        session.kill();
        self.scheduler.lock().await.stop(id);
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
                self.scheduler.lock().await.start(app.clone(), entry.value().clone());
            } else {
                session.active = false;
                self.scheduler.lock().await.stop(entry.key());
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
            crate::terminal_engine::frame::CursorPosition {
                row: cr,
                col: cc,
            }
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
        self.scheduler.lock().await.start(app, session.value().clone());
        Ok(())
    }

    pub async fn stop_frame_scheduler(&self, id: &str) {
        self.scheduler.lock().await.stop(id);
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
        let gray = ((idx - 232) * 255 / 23) as u8;
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
