use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tracing::{error, info, warn};
use portable_pty::{CommandBuilder, PtySize};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;

pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pty: Option<Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>>,
    pub reader: Option<Arc<Mutex<Box<dyn std::io::Read + Send>>>>,
    pub writer: Option<Arc<Mutex<Box<dyn std::io::Write + Send>>>>,
    pub grid: GridBuffer,
    pub parser: AnsiParser,
    pub active: bool,
    pub agent_id: Option<String>,
    pub exit_code: Option<i32>,
}

impl TerminalSession {
    pub fn new(id: String, shell: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            id,
            shell,
            cwd,
            pty: None,
            reader: None,
            writer: None,
            grid: GridBuffer::new(cols, rows),
            parser: AnsiParser::new(cols, rows),
            active: false,
            agent_id: None,
            exit_code: None,
        }
    }

    pub async fn spawn(&mut self, _app: AppHandle) -> Result<(), String> {
        if self.pty.is_some() {
            return Ok(());
        }

        let pty_system = portable_pty::native_pty_system();

        let pair = pty_system.openpty(PtySize {
            rows: self.grid.rows,
            cols: self.grid.cols,
            pixel_width: self.grid.cols as u16 * 8,
            pixel_height: self.grid.rows as u16 * 16,
        }).map_err(|e| {
            error!("Failed to open PTY: {}", e);
            format!("PTY open error: {}", e)
        })?;

        let mut cmd = CommandBuilder::new(&self.shell);
        cmd.cwd(&self.cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            error!("Failed to spawn shell: {}", e);
            format!("Shell spawn error: {}", e)
        })?;

        let child_killer = child.clone_killer();

        let reader = pair.master.try_clone_reader().map_err(|e| {
            error!("Failed to get PTY reader: {}", e);
            format!("PTY reader error: {}", e)
        })?;

        let writer = pair.master.take_writer().map_err(|e| {
            error!("Failed to get PTY writer: {}", e);
            format!("PTY writer error: {}", e)
        })?;

        self.pty = Some(Arc::new(Mutex::new(child_killer)));
        self.reader = Some(Arc::new(Mutex::new(reader)));
        self.writer = Some(Arc::new(Mutex::new(writer)));

        let reader_arc = self.reader.clone().unwrap();
        let id = self.id.clone();

        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            loop {
                let n = {
                    let mut reader = match reader_arc.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    match reader.read(&mut buf) {
                        Ok(n) if n > 0 => n,
                        Ok(0) => {
                            info!(terminal_id = %id, "PTY read EOF");
                            break;
                        }
                        Ok(_) => continue,
                        Err(e) => {
                            warn!(terminal_id = %id, error = %e, "PTY read error");
                            break;
                        }
                    }
                };

                info!(terminal_id = %id, bytes = n, "PTY data received");
            }
            info!(terminal_id = %id, "PTY reader task ended");
        });

        info!(terminal_id = %self.id, shell = %self.shell, "Shell spawned successfully");
        Ok(())
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if let Some(ref writer) = self.writer {
            let mut writer = writer.lock()
                .map_err(|_| "Writer lock poisoned".to_string())?;
            writer.write_all(data)
                .map_err(|e| format!("Write error: {}", e))?;
            Ok(())
        } else {
            Err("PTY not spawned".to_string())
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.grid.resize(cols, rows);
    }

    pub fn kill(&mut self) {
        if let Some(ref pty) = self.pty {
            let pty = pty.lock();
            if let Ok(mut pty) = pty {
                let _ = pty.kill();
            }
        }
        self.pty = None;
        self.reader = None;
        self.writer = None;
        info!(terminal_id = %self.id, "Terminal session cleaned up");
    }
}
