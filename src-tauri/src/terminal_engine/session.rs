use crate::agent_events::{agent_event_pipe_name, AGENT_EVENT_PROTOCOL};
use crate::jarvis::runtime_detector::{detect_from_command, AgentDetection};
use crate::terminal_engine::frame::{TerminalExited, TerminalOutput};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;
use crate::terminal_engine::TerminalAgentSnapshot;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

const MAX_COMMAND_BUFFER_BYTES: usize = 8 * 1024;
const MAX_INPUT_OPERATIONS: usize = 128;
pub(crate) const AGENT_PROCESS_MISS_THRESHOLD: u8 = 3;
pub const MIN_TERMINAL_COLS: u16 = 8;
pub const MIN_TERMINAL_ROWS: u16 = 2;

#[derive(Clone)]
struct InputOperationOutcome {
    id: String,
    payload_fingerprint: u64,
    result: Result<(), String>,
}

/// Liveness of the provider CLI below the long-lived PTY shell. PowerShell
/// can remain alive after the agent exits, so PTY liveness is a separate fact.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AgentRuntimePresence {
    ever_observed: bool,
    alive: bool,
    consecutive_misses: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentPresenceTransition {
    Unchanged,
    BecameActive,
    BecameInactive,
}

impl AgentRuntimePresence {
    pub(crate) fn observed(&mut self) -> AgentPresenceTransition {
        let transition = if self.alive {
            AgentPresenceTransition::Unchanged
        } else {
            AgentPresenceTransition::BecameActive
        };
        self.ever_observed = true;
        self.alive = true;
        self.consecutive_misses = 0;
        transition
    }

    pub(crate) fn missed(&mut self) -> AgentPresenceTransition {
        if !self.ever_observed || !self.alive {
            return AgentPresenceTransition::Unchanged;
        }
        self.consecutive_misses = self.consecutive_misses.saturating_add(1);
        if self.consecutive_misses < AGENT_PROCESS_MISS_THRESHOLD {
            return AgentPresenceTransition::Unchanged;
        }
        self.alive = false;
        AgentPresenceTransition::BecameInactive
    }

    pub(crate) fn alive(&self) -> Option<bool> {
        self.ever_observed.then_some(self.alive)
    }
}

fn input_payload_fingerprint(data: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

#[derive(Default)]
struct CommandInputBuffer {
    text: String,
    escape: Vec<u8>,
    bracketed_paste: bool,
}

impl CommandInputBuffer {
    fn reset(&mut self) {
        self.text.clear();
        self.escape.clear();
        self.bracketed_paste = false;
    }

    fn push_text(&mut self, text: &str, detections: &mut Vec<AgentDetection>) {
        for ch in text.chars() {
            match ch {
                '\r' | '\n' => {
                    if !self.text.trim().is_empty() {
                        if let Some(detection) = detect_from_command(&self.text) {
                            detections.push(detection);
                        }
                    }
                    self.text.clear();
                }
                '\u{8}' | '\u{7f}' => {
                    self.text.pop();
                }
                '\t' => self.push_char(' '),
                ch if ch.is_control() => self.reset(),
                ch => self.push_char(ch),
            }
        }
    }

    fn push_char(&mut self, ch: char) {
        if self.text.len() + ch.len_utf8() > MAX_COMMAND_BUFFER_BYTES {
            self.reset();
            return;
        }
        self.text.push(ch);
    }

    fn finish_escape(&mut self, detections: &mut Vec<AgentDetection>) {
        if self.escape == b"\x1b[200~" {
            self.bracketed_paste = true;
        } else if self.escape == b"\x1b[201~" {
            self.bracketed_paste = false;
        } else if self.escape == b"\x1b[3~" {
            // Delete has no cursor position in this bounded command tracker;
            // treating it like backspace is safe and prevents stale identity.
            self.text.pop();
        }
        self.escape.clear();
        let _ = detections;
    }

    fn observe(&mut self, data: &[u8]) -> Vec<AgentDetection> {
        let mut detections = Vec::new();
        let mut printable = Vec::new();
        for &byte in data {
            if !self.escape.is_empty() {
                self.escape.push(byte);
                if self.escape.len() > 32 {
                    self.escape.clear();
                } else if self.escape.len() >= 3 && (0x40..=0x7e).contains(&byte) {
                    self.finish_escape(&mut detections);
                }
                continue;
            }

            if byte == 0x1b {
                if !printable.is_empty() {
                    self.push_text(&String::from_utf8_lossy(&printable), &mut detections);
                    printable.clear();
                }
                self.escape.push(byte);
            } else if byte == 0x08
                || byte == 0x7f
                || byte == b'\r'
                || byte == b'\n'
                || byte == b'\t'
            {
                if !printable.is_empty() {
                    self.push_text(&String::from_utf8_lossy(&printable), &mut detections);
                    printable.clear();
                }
                self.push_text(&String::from_utf8_lossy(&[byte]), &mut detections);
            } else if byte.is_ascii_graphic() || byte == b' ' || byte >= 0x80 {
                printable.push(byte);
            } else {
                if !printable.is_empty() {
                    self.push_text(&String::from_utf8_lossy(&printable), &mut detections);
                    printable.clear();
                }
                self.reset();
            }
        }
        if !printable.is_empty() {
            self.push_text(&String::from_utf8_lossy(&printable), &mut detections);
        }
        detections
    }
}

pub struct TerminalSession {
    pub id: String,
    pub title: String,
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
    /// Stable persisted identity for Jarvis routing; never derived from the
    /// editable terminal title.
    pub agent_alias: Option<String>,
    pub observed_provider: Option<String>,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
    pub process_id: Option<u32>,
    pub is_agent_terminal: bool,
    pub(crate) agent_runtime_presence: AgentRuntimePresence,
    /// Set only by Jarvis backend-owned open/restart flows. Returning this in
    /// runtime identity prevents a missed frontend event from launching the
    /// provider CLI a second time.
    pub backend_agent_launch_state: Option<String>,
    /// Owning workspace, if known. Injected into the PTY environment so the
    /// agent-event bridge reports the correct TRAFLIX_WORKSPACE_ID.
    pub workspace_id: Option<String>,
    pub generation: u64,
    #[allow(dead_code)]
    pub exit_code: Option<i32>,
    pub reader_stop: Arc<AtomicBool>,
    pub exit_emitted: Arc<AtomicBool>,
    /// True only while the child process is alive. The session remains in the
    /// manager after a natural exit so the frontend can display its output,
    /// therefore `pty.is_some()` alone is not a valid liveness check.
    pub process_alive: Arc<AtomicBool>,
    /// Last observed child exit code; -1 means the watcher has not collected it.
    pub process_exit_code: Arc<AtomicI32>,
    pub output_sequence: Arc<AtomicU64>,
    /// Set to true when resolve_and_update_cwd updates the CWD.
    /// Read+reset by TerminalManager::write to emit cwd-changed event.
    pub cwd_changed: AtomicBool,
    /// Accumulates printable characters from keystroke writes to detect
    /// `cd` / `chdir` commands on Enter (\r). Each write() call typically
    /// contains one character for typed input. Reset on \r or escape seqs.
    cd_buffer: Mutex<String>,
    /// Separate bounded input tracker for complete command identity. It never
    /// shares the CWD buffer and never stores command text outside the session.
    command_buffer: Mutex<CommandInputBuffer>,
    /// Bounded, in-memory idempotency ledger for semantic writes such as an
    /// agent CLI launch. A repeated IPC request receives the first outcome and
    /// never writes the command twice into the same PTY generation.
    input_operations: VecDeque<InputOperationOutcome>,
}

impl TerminalSession {
    pub fn new(
        id: String,
        title: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            id,
            title,
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
            agent_alias: None,
            observed_provider: None,
            detection_source: "fallback".to_string(),
            detection_confidence: 0.2,
            identity_warnings: Vec::new(),
            process_id: None,
            is_agent_terminal: false,
            agent_runtime_presence: AgentRuntimePresence::default(),
            backend_agent_launch_state: None,
            workspace_id: None,
            generation: 0,
            exit_code: None,
            reader_stop: Arc::new(AtomicBool::new(false)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
            process_alive: Arc::new(AtomicBool::new(false)),
            process_exit_code: Arc::new(AtomicI32::new(-1)),
            output_sequence: Arc::new(AtomicU64::new(0)),
            cwd_changed: AtomicBool::new(false),
            cd_buffer: Mutex::new(String::new()),
            command_buffer: Mutex::new(CommandInputBuffer::default()),
            input_operations: VecDeque::new(),
        }
    }

    pub fn previous_input_operation(
        &self,
        operation_id: &str,
        data: &[u8],
    ) -> Result<Option<Result<(), String>>, String> {
        let Some(operation) = self
            .input_operations
            .iter()
            .find(|operation| operation.id == operation_id)
        else {
            return Ok(None);
        };
        if operation.payload_fingerprint != input_payload_fingerprint(data) {
            return Err("input-operation-payload-mismatch".to_string());
        }
        Ok(Some(operation.result.clone()))
    }

    pub fn record_input_operation(
        &mut self,
        operation_id: String,
        data: &[u8],
        result: Result<(), String>,
    ) {
        self.input_operations.push_back(InputOperationOutcome {
            id: operation_id,
            payload_fingerprint: input_payload_fingerprint(data),
            result,
        });
        while self.input_operations.len() > MAX_INPUT_OPERATIONS {
            self.input_operations.pop_front();
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
        self.process_exit_code.store(-1, Ordering::Release);
        self.output_sequence.store(0, Ordering::Release);

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
        cmd.env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV);
        cmd.env_remove(crate::settings::secrets::GROQ_API_KEY_ENV);
        let launch_cwd = self
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .map_err(|_| "Terminal CWD lock poisoned".to_string())?;
        cmd.cwd(&launch_cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TRAFLIX_TERMINAL_ID", &self.id);
        cmd.env("TRAFLIX_AGENT_EVENT_PIPE", agent_event_pipe_name());
        cmd.env(
            "TRAFLIX_AGENT_EVENT_PROTOCOL",
            AGENT_EVENT_PROTOCOL.to_string(),
        );
        cmd.env("TRAFLIX_TERMINAL_GENERATION", self.generation.to_string());
        if let Some(bridge_path) = resolve_agent_bridge_path(&app) {
            let bridge_str = bridge_path.to_string_lossy().to_string();
            // Strip the Windows extended-length prefix (\\?\ and \\?\UNC\)
            // that resource_dir() may produce, otherwise `powershell -File`
            // cannot invoke the bridge.
            let clean = if let Some(rest) = bridge_str.strip_prefix(r"\\?\UNC\") {
                format!("\\\\{}", rest)
            } else if let Some(rest) = bridge_str.strip_prefix(r"\\?\") {
                rest.to_string()
            } else {
                bridge_str
            };
            cmd.env("TRAFLIX_AGENT_EVENT_BRIDGE", clean);
        }
        if let Some(workspace_id) = &self.workspace_id {
            cmd.env("TRAFLIX_WORKSPACE_ID", workspace_id);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            error!("Failed to spawn shell: {}", e);
            format!("Shell spawn error: {}", e)
        })?;

        let child_killer = child.clone_killer();
        self.process_id = child.process_id();

        let reader = pair.master.try_clone_reader().map_err(|e| {
            error!("Failed to get PTY reader: {}", e);
            format!("PTY reader error: {}", e)
        })?;

        let writer = pair.master.take_writer().map_err(|e| {
            error!("Failed to get PTY writer: {}", e);
            format!("PTY writer error: {}", e)
        })?;

        let child_arc = Arc::new(Mutex::new(child));
        let reader_arc = Arc::new(Mutex::new(reader));
        self.child = Some(child_arc.clone());
        self.pty = Some(Arc::new(Mutex::new(child_killer)));
        self.master = Some(Arc::new(Mutex::new(pair.master)));
        self.reader = Some(reader_arc.clone());
        self.writer = Some(Arc::new(Mutex::new(writer)));
        self.process_alive.store(true, Ordering::Release);

        let app_reader = app.clone();
        let app_watch = app.clone();
        let parser = self.parser.clone();
        // Arc<str> avoids allocating a new String on every terminal-output emit.
        let id: Arc<str> = Arc::from(self.id.as_str());
        let stop = self.reader_stop.clone();
        let exit_emitted_reader = self.exit_emitted.clone();
        let process_alive_reader = self.process_alive.clone();
        let output_sequence_reader = self.output_sequence.clone();
        let child_for_reader = child_arc.clone();
        let process_exit_code_reader = self.process_exit_code.clone();
        let process_exit_code_watch = self.process_exit_code.clone();
        let registry_workspace_id = self.workspace_id.clone().unwrap_or_default();
        let registry_is_agent_terminal = self.is_agent_terminal;
        let registry_agent_id = self.agent_id.clone();
        let registry_agent_alias = self.agent_alias.clone();
        let registry_generation = self.generation;
        let registry_process_id = self.process_id;

        // PTY reader thread — exits on stop flag, EOF, or after master is dropped.
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 32768];
            let mut natural_exit = false;
            // Output-driven `lastActivityAt` updates are throttled to at most
            // one per second so PTY chunks never touch the registry per chunk.
            let mut last_output_observe: Option<std::time::Instant> = None;

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

                let sequence = if let Ok(mut p) = parser.lock() {
                    p.process(&data);
                    output_sequence_reader.fetch_add(1, Ordering::AcqRel) + 1
                } else {
                    output_sequence_reader.fetch_add(1, Ordering::AcqRel) + 1
                };

                let _ = app_reader.emit(
                    "terminal-output",
                    TerminalOutput {
                        terminal_id: id.to_string(),
                        workspace_id: registry_workspace_id.clone(),
                        generation: registry_generation,
                        process_id: registry_process_id,
                        data,
                        sequence,
                    },
                );

                if registry_is_agent_terminal {
                    let due = last_output_observe.map_or(true, |instant| {
                        instant.elapsed() >= std::time::Duration::from_secs(1)
                    });
                    if due {
                        last_output_observe = Some(std::time::Instant::now());
                        if let Some(state) = app_reader.try_state::<crate::jarvis::JarvisState>() {
                            state.registry.observe_output(
                                &id,
                                registry_generation,
                                &chrono::Utc::now().to_rfc3339(),
                            );
                        }
                    }
                }
            }

            if natural_exit {
                process_alive_reader.store(false, Ordering::Release);
                super::notify_agent_exit(
                    &app_reader,
                    &TerminalAgentSnapshot {
                        terminal_id: id.to_string(),
                        workspace_id: registry_workspace_id.clone(),
                        is_agent_terminal: registry_is_agent_terminal,
                        agent_id: registry_agent_id.clone(),
                        agent_alias: registry_agent_alias.clone(),
                        observed_provider: None,
                        detection_source: "fallback".to_string(),
                        detection_confidence: 0.2,
                        identity_warnings: Vec::new(),
                        generation: registry_generation,
                        process_id: registry_process_id,
                        process_alive: false,
                        agent_process_alive: None,
                    },
                );
            }

            // Explicitly drop reader so the OS handle is released even if the
            // session-side Arc was already cleared by kill().
            drop(reader_arc);

            info!(terminal_id = %id, "PTY reader task ended");

            if natural_exit && !stop.load(Ordering::Acquire) {
                let exit_code = collect_exit_code(&child_for_reader, &process_exit_code_reader);
                if exit_emitted_reader
                    .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                    .is_ok()
                {
                    let _ = app_reader.emit(
                        "terminal-exited",
                        TerminalExited {
                            terminal_id: id.to_string(),
                            workspace_id: registry_workspace_id.clone(),
                            generation: registry_generation,
                            process_id: registry_process_id,
                            exit_code,
                        },
                    );
                }
            }
        });

        // Child-process watch thread (fallback when reader misses EOF on ConPTY).
        let watch_id: Arc<str> = Arc::from(self.id.as_str());
        let watch_stop = self.reader_stop.clone();
        let watch_child = child_arc;
        let exit_emitted_watch = self.exit_emitted.clone();
        let process_alive_watch = self.process_alive.clone();
        let registry_workspace_id_watch = self.workspace_id.clone().unwrap_or_default();
        let registry_is_agent_terminal_watch = self.is_agent_terminal;
        let registry_agent_id_watch = self.agent_id.clone();
        let registry_agent_alias_watch = self.agent_alias.clone();
        let registry_generation_watch = self.generation;
        let registry_process_id_watch = self.process_id;
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
                    Ok(Some(status)) => {
                        process_exit_code_watch.store(status.exit_code() as i32, Ordering::Release);
                        true
                    }
                    Ok(None) => false,
                    Err(_) => true,
                }
            };

            if exited {
                process_alive_watch.store(false, Ordering::Release);
                super::notify_agent_exit(
                    &app_watch,
                    &TerminalAgentSnapshot {
                        terminal_id: watch_id.to_string(),
                        workspace_id: registry_workspace_id_watch.clone(),
                        is_agent_terminal: registry_is_agent_terminal_watch,
                        agent_id: registry_agent_id_watch.clone(),
                        agent_alias: registry_agent_alias_watch.clone(),
                        observed_provider: None,
                        detection_source: "fallback".to_string(),
                        detection_confidence: 0.2,
                        identity_warnings: Vec::new(),
                        generation: registry_generation_watch,
                        process_id: registry_process_id_watch,
                        process_alive: false,
                        agent_process_alive: None,
                    },
                );
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
                            workspace_id: registry_workspace_id_watch.clone(),
                            generation: registry_generation_watch,
                            process_id: registry_process_id_watch,
                            exit_code: process_exit_code_watch.load(Ordering::Acquire).max(0),
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

    /// Observe only complete shell commands. The caller applies the resulting
    /// identity outside the PTY writer lock, so a detector can never block
    /// input or resize.
    pub fn observe_agent_commands(&self, data: &[u8]) -> Vec<AgentDetection> {
        self.command_buffer
            .lock()
            .map(|mut buffer| buffer.observe(data))
            .unwrap_or_default()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        if cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS {
            return Err(format!(
                "unstable-terminal-layout: minimum {}x{}, received {}x{}",
                MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, cols, rows
            ));
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

    pub fn kill(&mut self) -> Result<(), String> {
        // Do not tear down the session until the OS accepted termination. A
        // failed ChildKiller call must leave all handles and liveness state in
        // place so the manager can reinsert the exact session and let the user
        // retry, instead of reporting a false successful close.
        if self.process_alive.load(Ordering::Acquire) {
            let kill_result = self
                .pty
                .as_ref()
                .ok_or_else(|| "PTY child killer unavailable".to_string())
                .and_then(|pty| {
                    let mut killer = pty
                        .lock()
                        .map_err(|_| "PTY child killer lock poisoned".to_string())?;
                    killer
                        .kill()
                        .map_err(|error| format!("PTY child kill failed: {error}"))
                });

            if let Err(kill_error) = kill_result {
                // A process can exit naturally just before kill reaches the
                // OS. Treat that case as success, but never hide a live child
                // or a failed liveness check.
                let observed_exit = match self.child.as_ref() {
                    Some(child) => {
                        let mut child = child
                            .lock()
                            .map_err(|_| format!("{kill_error}; child lock poisoned"))?;
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                self.process_exit_code
                                    .store(status.exit_code() as i32, Ordering::Release);
                                true
                            }
                            Ok(None) => false,
                            Err(error) => {
                                return Err(format!(
                                    "{kill_error}; child liveness check failed: {error}"
                                ));
                            }
                        }
                    }
                    None => false,
                };
                if !observed_exit {
                    return Err(kill_error);
                }
            }
        }

        // 1. Signal reader + watch threads (Acquire/Release pairing with loads).
        self.reader_stop.store(true, Ordering::Release);
        self.process_alive.store(false, Ordering::Release);

        // 2. Suppress exit events for a manager-owned close. If the watcher
        // won a genuine exit race before this point, its event remains valid.
        self.exit_emitted.store(true, Ordering::Release);

        // 3. Drop writer so the child sees EOF on stdin.
        self.writer = None;

        // 4. Best-effort reap after a successful kill/natural exit. Failure at
        // this point is diagnostic only: termination was already confirmed or
        // accepted by the OS and retaining a dead session cannot improve it.
        if let Some(ref child) = self.child {
            if let Ok(mut c) = child.lock() {
                let _ = c.try_wait();
            }
        }

        // 5. Drop master PTY — closes the pair and unblocks a blocking
        //    reader.read() so the spawn_blocking reader task can finish.
        self.master = None;
        self.pty = None;
        self.reader = None;
        self.child = None;

        // 6. Free scrollback/screen buffers held by a lingering Arc session.
        let cols = self.grid.cols.max(1);
        let rows = self.grid.rows.max(1);
        self.grid = GridBuffer::new(cols, rows);
        if let Ok(mut p) = self.parser.lock() {
            *p = AnsiParser::new(cols, rows);
        }

        info!(terminal_id = %self.id, "Terminal session cleaned up");
        Ok(())
    }
}

fn collect_exit_code(
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    shared: &AtomicI32,
) -> i32 {
    for _ in 0..20 {
        if let Ok(mut child) = child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                let code = status.exit_code() as i32;
                shared.store(code, Ordering::Release);
                return code.max(0);
            }
        }
        let known = shared.load(Ordering::Acquire);
        if known >= 0 {
            return known;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    shared.load(Ordering::Acquire).max(0)
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

#[cfg(test)]
mod tests {
    use super::{AgentPresenceTransition, AgentRuntimePresence, TerminalSession};
    use portable_pty::ChildKiller;
    use std::io;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    #[test]
    fn agent_child_exit_is_detected_while_the_pty_shell_remains_alive() {
        let mut presence = AgentRuntimePresence::default();
        assert_eq!(presence.alive(), None);
        assert_eq!(presence.observed(), AgentPresenceTransition::BecameActive);
        assert_eq!(presence.alive(), Some(true));
        assert_eq!(presence.missed(), AgentPresenceTransition::Unchanged);
        assert_eq!(presence.alive(), Some(true));
        assert_eq!(presence.missed(), AgentPresenceTransition::Unchanged);
        assert_eq!(presence.alive(), Some(true));
        assert_eq!(presence.missed(), AgentPresenceTransition::BecameInactive);
        assert_eq!(presence.alive(), Some(false));
        assert_eq!(presence.missed(), AgentPresenceTransition::Unchanged);
        assert_eq!(presence.observed(), AgentPresenceTransition::BecameActive);
    }

    #[derive(Clone, Copy, Debug)]
    struct TestChildKiller {
        succeeds: bool,
    }

    impl ChildKiller for TestChildKiller {
        fn kill(&mut self) -> io::Result<()> {
            if self.succeeds {
                Ok(())
            } else {
                Err(io::Error::other("injected kill failure"))
            }
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(*self)
        }
    }

    fn make_session() -> TerminalSession {
        TerminalSession::new(
            "terminal-test".to_string(),
            "Terminal".to_string(),
            "shell".to_string(),
            ".".to_string(),
            80,
            24,
        )
    }

    fn set_test_killer(session: &mut TerminalSession, succeeds: bool) {
        let killer: Box<dyn ChildKiller + Send> = Box::new(TestChildKiller { succeeds });
        session.pty = Some(Arc::new(Mutex::new(killer)));
    }

    #[test]
    fn command_detection_waits_for_a_complete_line() {
        let session = make_session();
        for byte in b"codex --resume" {
            assert!(session.observe_agent_commands(&[*byte]).is_empty());
        }
        let detections = session.observe_agent_commands(b"\r");
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].provider, "codex");
    }

    #[test]
    fn command_buffer_handles_editing_paste_and_navigation_sequences() {
        let session = make_session();
        assert!(session
            .observe_agent_commands(b"codexx\x08\x1b[A\x1b[3~x")
            .is_empty());
        let detections = session.observe_agent_commands(b"\r");
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].provider, "codex");

        let session = make_session();
        assert!(session
            .observe_agent_commands(b"\x1b[200~pnpm exec claude\x1b[201~")
            .is_empty());
        let detections = session.observe_agent_commands(b"\n");
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].provider, "claude");
    }

    #[test]
    fn command_buffer_does_not_classify_output_or_shell_wrappers() {
        let session = make_session();
        assert!(session.observe_agent_commands(b"echo codex\r").is_empty());
        assert!(session
            .observe_agent_commands(b"powershell codex\r")
            .is_empty());
        assert!(session.observe_agent_commands(b"codex\r").len() == 1);
    }

    #[test]
    fn semantic_input_operation_replays_outcome_without_reapplying_payload() {
        let mut session = make_session();
        let payload = b"codex\r\n";
        assert!(session
            .previous_input_operation("agent-launch:test", payload)
            .unwrap()
            .is_none());

        session.record_input_operation("agent-launch:test".to_string(), payload, Ok(()));
        assert_eq!(
            session
                .previous_input_operation("agent-launch:test", payload)
                .unwrap(),
            Some(Ok(())),
        );
        assert_eq!(
            session
                .previous_input_operation("agent-launch:test", b"claude\r\n")
                .unwrap_err(),
            "input-operation-payload-mismatch",
        );
    }

    #[test]
    fn transient_terminal_sizes_are_rejected_before_reaching_the_pty() {
        let mut session = make_session();
        assert!(session.resize(2, 24).is_err());
        assert!(session.resize(80, 1).is_err());
        assert!(session.resize(8, 2).is_ok());
    }

    #[test]
    fn failed_child_kill_preserves_a_retryable_live_session() {
        let mut session = make_session();
        session.process_alive.store(true, Ordering::Release);
        set_test_killer(&mut session, false);

        assert!(session.kill().is_err());
        assert!(session.process_alive.load(Ordering::Acquire));
        assert!(!session.reader_stop.load(Ordering::Acquire));
        assert!(!session.exit_emitted.load(Ordering::Acquire));
        assert!(session.pty.is_some());
    }

    #[test]
    fn successful_child_kill_commits_cleanup() {
        let mut session = make_session();
        session.process_alive.store(true, Ordering::Release);
        set_test_killer(&mut session, true);

        session.kill().unwrap();
        assert!(!session.process_alive.load(Ordering::Acquire));
        assert!(session.reader_stop.load(Ordering::Acquire));
        assert!(session.exit_emitted.load(Ordering::Acquire));
        assert!(session.pty.is_none());
    }
}
