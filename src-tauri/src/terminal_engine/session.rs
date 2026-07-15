use crate::terminal_engine::frame::{TerminalExited, TerminalOutput};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pty: Option<Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>>,
    pub master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    pub reader: Option<Arc<Mutex<Box<dyn std::io::Read + Send>>>>,
    pub writer: Option<Arc<Mutex<Box<dyn std::io::Write + Send>>>>,
    pub child: Option<Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>>,
    pub grid: GridBuffer,
    pub parser: Arc<Mutex<AnsiParser>>,
    pub active: bool,
    #[allow(dead_code)]
    pub agent_id: Option<String>,
    #[allow(dead_code)]
    pub exit_code: Option<i32>,
    pub reader_stop: Arc<AtomicBool>,
    pub exit_emitted: Arc<AtomicBool>,
}

impl TerminalSession {
    pub fn new(id: String, shell: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            id,
            shell,
            cwd,
            pty: None,
            master: None,
            reader: None,
            writer: None,
            child: None,
            grid: GridBuffer::new(cols, rows),
            parser: Arc::new(Mutex::new(AnsiParser::new(cols, rows))),
            active: false,
            agent_id: None,
            exit_code: None,
            reader_stop: Arc::new(AtomicBool::new(false)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn spawn(&mut self, app: AppHandle) -> Result<(), String> {
        if self.pty.is_some() {
            return Ok(());
        }

        let pty_system = portable_pty::native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: self.grid.rows,
                cols: self.grid.cols,
                pixel_width: self.grid.cols as u16 * 8,
                pixel_height: self.grid.rows as u16 * 16,
            })
            .map_err(|e| {
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

        let child_arc = Arc::new(Mutex::new(child));
        self.child = Some(child_arc.clone());
        self.pty = Some(Arc::new(Mutex::new(child_killer)));
        self.master = Some(Arc::new(Mutex::new(pair.master)));
        self.reader = Some(Arc::new(Mutex::new(reader)));
        self.writer = Some(Arc::new(Mutex::new(writer)));

        let app_reader = app.clone();
        let app_watch = app.clone();
        let reader_arc = self.reader.clone().unwrap();
        let parser = self.parser.clone();
        let id = self.id.clone();
        let stop = self.reader_stop.clone();
        let exit_emitted_reader = self.exit_emitted.clone();

        // Thread lettore PTY: legge l'output del processo
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 65536];
            let mut natural_exit = false;

            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let n = {
                    let mut reader = match reader_arc.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    match reader.read(&mut buf) {
                        Ok(n) if n > 0 => n,
                        Ok(0) => {
                            natural_exit = true;
                            info!(terminal_id = %id, "PTY read EOF");
                            break;
                        }
                        Ok(_) => continue,
                        Err(e) => {
                            // Su Windows/ConPTY, ERROR_BROKEN_PIPE è normale quando il
                            // processo figlio termina — trattalo come EOF naturale
                            natural_exit = true;
                            warn!(terminal_id = %id, error = %e, "PTY read error (treating as EOF)");
                            break;
                        }
                    }
                };

                let data = buf[..n].to_vec();

                if let Ok(mut p) = parser.lock() {
                    p.process(&data);
                    drop(p);
                }

                let _ = app_reader.emit(
                    "terminal-output",
                    TerminalOutput {
                        terminal_id: id.clone(),
                        data,
                    },
                );
            }

            info!(terminal_id = %id, "PTY reader task ended");

            if natural_exit
                && exit_emitted_reader
                    .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                    .is_ok()
            {
                let _ = app_reader.emit(
                    "terminal-exited",
                    TerminalExited {
                        terminal_id: id.clone(),
                        exit_code: 0,
                    },
                );
            }
        });

        // Thread watch del processo figlio: aspetta che il processo termini
        // e se il reader non ha già emesso l'evento di exit, lo emette qui.
        // Questo è un fallback per Windows/ConPTY dove il reader potrebbe
        // non ricevere EOF pulito.
        let watch_id = self.id.clone();
        let watch_stop = self.reader_stop.clone();
        let watch_child = child_arc.clone();
        let exit_emitted_watch = self.exit_emitted.clone();
        tokio::task::spawn_blocking(move || {
            loop {
                if watch_stop.load(Ordering::Relaxed) {
                    return; // kill forzata, non emettere evento
                }

                let exited = {
                    let mut c = match watch_child.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    match c.try_wait() {
                        Ok(Some(_status)) => true,
                        Ok(None) => false,
                        Err(_) => true,
                    }
                };

                if exited {
                    info!(terminal_id = %watch_id, "Child process exited (watch thread)");
                    if exit_emitted_watch
                        .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                        .is_ok()
                    {
                        let _ = app_watch.emit(
                            "terminal-exited",
                            TerminalExited {
                                terminal_id: watch_id.clone(),
                                exit_code: 0,
                            },
                        );
                    }
                    return;
                }

                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });

        info!(terminal_id = %self.id, shell = %self.shell, "Shell spawned successfully");
        Ok(())
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if let Some(ref writer) = self.writer {
            let mut writer = writer
                .lock()
                .map_err(|_| "Writer lock poisoned".to_string())?;
            writer
                .write_all(data)
                .map_err(|e| format!("Write error: {}", e))?;
            Ok(())
        } else {
            Err("PTY not spawned".to_string())
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.grid.resize(cols, rows);
        if let Some(ref master) = self.master {
            let master = master
                .lock()
                .map_err(|_| "Master lock poisoned".to_string())?;
            master
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: cols * 8,
                    pixel_height: rows * 16,
                })
                .map_err(|e| format!("PTY resize error: {}", e))?;
        }
        Ok(())
    }

    pub fn kill(&mut self) {
        self.reader_stop.store(true, Ordering::Relaxed);
        if let Some(ref pty) = self.pty {
            let pty = pty.lock();
            if let Ok(mut pty) = pty {
                let _ = pty.kill();
            }
        }
        self.pty = None;
        self.reader = None;
        self.writer = None;
        self.child = None;
        info!(terminal_id = %self.id, "Terminal session cleaned up");
    }
}
