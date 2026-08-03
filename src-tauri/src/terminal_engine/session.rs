use crate::agent_events::{AGENT_EVENT_PIPE_NAME, AGENT_EVENT_PROTOCOL};
use crate::terminal_engine::frame::{TerminalExited, TerminalOutput};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: std::sync::Mutex<String>,
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
    /// Set to true when resolve_and_update_cwd updates the CWD.
    /// Read+reset by TerminalManager::write to emit cwd-changed event.
    pub cwd_changed: AtomicBool,
    /// Accumulates printable characters from keystroke writes to detect
    /// `cd` / `chdir` commands on Enter (\r). Each write() call typically
    /// contains one character for typed input. Reset on \r or escape seqs.
    cd_buffer: Mutex<String>,
}

impl TerminalSession {
    pub fn new(id: String, shell: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            id,
            shell,
            cwd: std::sync::Mutex::new(cwd),
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
            cwd_changed: AtomicBool::new(false),
            cd_buffer: Mutex::new(String::new()),
        }
    }

    pub async fn spawn(&mut self, app: AppHandle) -> Result<(), String> {
        if self.pty.is_some() {
            return Ok(());
        }

        // Allow re-spawn after a previous kill on a reused session struct
        // (normally sessions are removed from the map; reopen creates fresh ones).
        self.reader_stop.store(false, Ordering::Relaxed);
        self.exit_emitted.store(false, Ordering::Relaxed);

        let pty_system = portable_pty::native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: self.grid.rows,
                cols: self.grid.cols,
                pixel_width: self.grid.cols * 8,
                pixel_height: self.grid.rows * 16,
            })
            .map_err(|e| {
                error!("Failed to open PTY: {}", e);
                format!("PTY open error: {}", e)
            })?;

        let mut cmd = CommandBuilder::new(&self.shell);
        cmd.cwd(self.cwd.lock().unwrap().as_str());
        cmd.env("TERM", "xterm-256color");
        cmd.env("TRAFLIX_TERMINAL_ID", &self.id);
        cmd.env("TRAFLIX_AGENT_EVENT_PIPE", AGENT_EVENT_PIPE_NAME);
        cmd.env(
            "TRAFLIX_AGENT_EVENT_PROTOCOL",
            AGENT_EVENT_PROTOCOL.to_string(),
        );
        if let Some(bridge_path) = resolve_agent_bridge_path(&app) {
            cmd.env("TRAFLIX_AGENT_EVENT_BRIDGE", bridge_path);
        }

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
        // Arc<str> avoids allocating a new String on every terminal-output emit.
        let id: Arc<str> = Arc::from(self.id.as_str());
        let stop = self.reader_stop.clone();
        let exit_emitted_reader = self.exit_emitted.clone();

        // PTY reader thread — exits on stop flag, EOF, or after master is dropped.
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 32768];
            let mut natural_exit = false;

            loop {
                if stop.load(Ordering::Acquire) {
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
                            // ConPTY: broken pipe is normal when the child exits.
                            // Also expected after kill() drops the master handle.
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            natural_exit = true;
                            warn!(terminal_id = %id, error = %e, "PTY read error (treating as EOF)");
                            break;
                        }
                    }
                };

                // Clone only the valid slice once for both parser + emit.
                let data = buf[..n].to_vec();

                if let Ok(mut p) = parser.lock() {
                    p.process(&data);
                }

                let _ = app_reader.emit(
                    "terminal-output",
                    TerminalOutput {
                        terminal_id: id.to_string(),
                        data,
                    },
                );
            }

            // Explicitly drop reader so the OS handle is released even if the
            // session-side Arc was already cleared by kill().
            drop(reader_arc);

            info!(terminal_id = %id, "PTY reader task ended");

            if natural_exit
                && !stop.load(Ordering::Acquire)
                && exit_emitted_reader
                    .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                    .is_ok()
            {
                let _ = app_reader.emit(
                    "terminal-exited",
                    TerminalExited {
                        terminal_id: id.to_string(),
                        exit_code: 0,
                    },
                );
            }
        });

        // Child-process watch thread (fallback when reader misses EOF on ConPTY).
        let watch_id: Arc<str> = Arc::from(self.id.as_str());
        let watch_stop = self.reader_stop.clone();
        let watch_child = child_arc;
        let exit_emitted_watch = self.exit_emitted.clone();
        tokio::task::spawn_blocking(move || loop {
            if watch_stop.load(Ordering::Acquire) {
                return;
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
                if !watch_stop.load(Ordering::Acquire)
                    && exit_emitted_watch
                        .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                        .is_ok()
                {
                    let _ = app_watch.emit(
                        "terminal-exited",
                        TerminalExited {
                            terminal_id: watch_id.to_string(),
                            exit_code: 0,
                        },
                    );
                }
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(250));
        });

        info!(terminal_id = %self.id, shell = %self.shell, "Shell spawned successfully");
        Ok(())
    }

    /// Accumulate keystrokes and detect `cd` / `chdir` commands on Enter.
    /// Individual keystrokes arrive character-by-character (separate write()
    /// calls), so we buffer printable chars in cd_buffer.
    /// Paste / agent writes (text.len() > 10) are checked inline for `cd <path>`.
    fn update_cwd_from_input(&self, data: &[u8]) {
        let text = match std::str::from_utf8(data) {
            Ok(t) => t,
            Err(_) => return,
        };

        // Check if this looks like a paste or agent command (multi-char write).
        let is_paste = text.contains("\x1b[200~");
        if is_paste || text.len() > 10 {
            // A paste can contain any supported command (`cd`, `chdir`,
            // `Set-Location`, `sl`), not just the literal `cd ` prefix.
            if let Some(p) = Self::extract_cd_path_from_input(text) {
                info!(
                    terminal_cwd_detected = "paste",
                    raw = %text,
                    path = %p,
                    "Paste/agent cd command detected"
                );
                Self::resolve_and_update_cwd(&self.cwd, &self.cwd_changed, &p);
                return;
            }
            // Not a cd command — clear buffer to avoid cross-talk with keystrokes.
            if let Ok(mut buf) = self.cd_buffer.lock() {
                buf.clear();
            }
            return;
        }

        // Keystroke-by-keystroke: accumulate into buffer.
        let mut buf = match self.cd_buffer.lock() {
            Ok(b) => b,
            Err(_) => return,
        };

        for ch in text.chars() {
            match ch {
                '\r' | '\n' => {
                    let line = buf.clone();
                    let trimmed = line.trim().to_string();
                    buf.clear();
                    if !trimmed.is_empty() {
                        if let Some(p) = Self::extract_cd_path_from(&trimmed) {
                            info!(
                                terminal_cwd_detected = "keystroke",
                                buffer = %trimmed,
                                path = %p,
                                "Keystroke cd command detected"
                            );
                            drop(buf);
                            Self::resolve_and_update_cwd(&self.cwd, &self.cwd_changed, &p);
                            return;
                        }
                    }
                }
                '\x08' | '\x7f' => {
                    buf.pop();
                }
                '\x1b' => {
                    // Escape sequence start — reset buffer
                    buf.clear();
                }
                c if c.is_control() => {
                    // Other control chars — reset buffer (safety)
                    buf.clear();
                }
                c => {
                    buf.push(c);
                }
            }
        }
    }

    /// Extract the path from a string starting with a cd-like command.
    /// Supports: `cd `, `chdir `, `CD `, `CHDIR `, `Set-Location `, `sl `.
    fn extract_cd_path_from(s: &str) -> Option<String> {
        // A terminal command must start with the cd-like verb. Searching inside
        // the input would incorrectly treat e.g. `echo cd .\\project` as a
        // directory change.
        let prefixes = [
            "cd ",
            "chdir ",
            "CD ",
            "CHDIR ",
            "Set-Location ",
            "set-location ",
            "sl ",
            "SL ",
        ];

        let command = s.trim_start_matches("\x1b[200~").trim_start();
        let remainder = prefixes
            .iter()
            .find_map(|prefix| command.strip_prefix(prefix))?;

        // Take up to \r or \n. A clipboard paste is wrapped in bracketed
        // paste markers, whose closing `ESC[201~` is not entirely control
        // characters and would otherwise be treated as part of the path.
        let line = remainder
            .split(|c: char| c == '\r' || c == '\n')
            .next()
            .unwrap_or("")
            .trim_end();
        let path = line
            .strip_suffix("\x1b[201~")
            .unwrap_or(line)
            .trim_end_matches(|c: char| c.is_control() || c.is_whitespace());

        if path.is_empty() || path == "~" {
            None
        } else {
            Some(path.to_string())
        }
    }

    /// Find the first directory-change command in a pasted multi-line input.
    /// Every line is still parsed from its start, so `echo cd ..` is never
    /// mistaken for a real directory change.
    fn extract_cd_path_from_input(input: &str) -> Option<String> {
        input
            .trim_start_matches("\x1b[200~")
            .split(|c: char| c == '\r' || c == '\n')
            .find_map(Self::extract_cd_path_from)
    }

    /// Resolve a path string (absolute or relative to cwd) and update cwd.
    /// Strips surrounding single/double quotes (PowerShell syntax).
    /// Handles Windows drive letters ("D:" → "D:\").
    /// Sets cwd_changed to true if the update succeeds.
    fn resolve_and_update_cwd(
        cwd_mutex: &std::sync::Mutex<String>,
        cwd_changed: &AtomicBool,
        path_str: &str,
    ) {
        // Strip one matching pair of PowerShell quotes while keeping path
        // separators intact (notably a drive root such as `C:\\`).
        let trimmed = path_str.trim();
        let cleaned = trimmed
            .strip_prefix('\'')
            .and_then(|path| path.strip_suffix('\''))
            .or_else(|| {
                trimmed
                    .strip_prefix('"')
                    .and_then(|path| path.strip_suffix('"'))
            })
            .unwrap_or(trimmed);

        // Detect Windows bare drive letter "D:" → make "D:\" absolute
        let expanded = if cleaned.len() == 2 && cleaned.chars().nth(1) == Some(':') {
            let mut d = cleaned.to_string();
            d.push('\\');
            d
        } else {
            cleaned.to_string()
        };

        let current_cwd = match cwd_mutex.lock() {
            Ok(g) => g.clone(),
            Err(_) => return,
        };
        let current = std::path::PathBuf::from(&current_cwd);

        let new_path = if std::path::Path::new(&expanded).is_absolute()
            || expanded.contains(":\\")
            || expanded.contains(":/")
        {
            std::path::PathBuf::from(&expanded)
        } else {
            current.join(&expanded)
        };

        match new_path.canonicalize() {
            Ok(canonical) => {
                // `canonicalize()` on Windows returns an extended-length path
                // (`\\?\C:\...`). Keep that internal implementation detail out
                // of shell commands, logs, and title-bar state.
                let new_cwd_str = canonical
                    .to_string_lossy()
                    .trim_start_matches("\\\\?\\")
                    .trim_start_matches("\\\\.\\")
                    .to_string();
                info!(
                    terminal_cwd_changed = true,
                    from = %current_cwd,
                    to = %new_cwd_str,
                    via = %path_str,
                    "CD detected — CWD updated"
                );
                if let Ok(mut cwd_guard) = cwd_mutex.lock() {
                    *cwd_guard = new_cwd_str;
                    cwd_changed.store(true, Ordering::Release);
                }
            }
            Err(e) => {
                info!(
                    terminal_cwd_resolve_failed = true,
                    raw = %path_str,
                    cleaned = %cleaned,
                    error = %e,
                    "CD path canonicalize failed"
                );
            }
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if self.reader_stop.load(Ordering::Acquire) {
            return Err("Terminal is shutting down".to_string());
        }

        // Track cd commands to update the stored CWD.
        self.update_cwd_from_input(data);

        if let Some(ref writer) = self.writer {
            let mut writer = writer
                .lock()
                .map_err(|_| "Writer lock poisoned".to_string())?;
            writer
                .write_all(data)
                .map_err(|e| format!("Write error: {}", e))?;
            // Flush so agents / paste bursts reach the child promptly.
            writer.flush().map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err("PTY not spawned".to_string())
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("Invalid terminal size".to_string());
        }
        if self.grid.cols == cols && self.grid.rows == rows {
            return Ok(());
        }

        self.grid.resize(cols, rows);

        // Keep the vt100 parser in sync with the PTY size so snapshots after
        // remount match the live geometry.
        if let Ok(mut p) = self.parser.lock() {
            p.resize(cols, rows);
        }

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
        // 1. Signal reader + watch threads (Acquire/Release pairing with loads).
        self.reader_stop.store(true, Ordering::Release);

        // 2. Suppress exit events for forced kills.
        self.exit_emitted.store(true, Ordering::Release);

        // 3. Drop writer so the child sees EOF on stdin.
        self.writer = None;

        // 4. Kill the child process tree via portable-pty ChildKiller.
        if let Some(ref pty) = self.pty {
            if let Ok(mut killer) = pty.lock() {
                let _ = killer.kill();
            }
        }

        // 5. Best-effort wait so the OS reaps the process promptly.
        if let Some(ref child) = self.child {
            if let Ok(mut c) = child.lock() {
                let _ = c.try_wait();
            }
        }

        // 6. Drop master PTY — closes the pair and unblocks a blocking
        //    reader.read() so the spawn_blocking reader task can finish.
        self.master = None;
        self.pty = None;
        self.reader = None;
        self.child = None;

        // 7. Free scrollback/screen buffers held by a lingering Arc session.
        let cols = self.grid.cols.max(1);
        let rows = self.grid.rows.max(1);
        self.grid = GridBuffer::new(cols, rows);
        if let Ok(mut p) = self.parser.lock() {
            *p = AnsiParser::new(cols, rows);
        }

        info!(terminal_id = %self.id, "Terminal session cleaned up");
    }
}

fn resolve_agent_bridge_path(app: &AppHandle) -> Option<PathBuf> {
    let configured = std::env::var_os("TRAFLIX_AGENT_EVENT_BRIDGE").map(PathBuf::from);
    let resource = app.path().resource_dir().ok().map(|path| {
        path.join("agent-notifications")
            .join("traflix-agent-event.ps1")
    });
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("agent-notifications")
        .join("traflix-agent-event.ps1");

    [configured, resource, Some(development)]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}
