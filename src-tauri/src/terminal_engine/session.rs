use crate::jarvis::runtime_detector::{detect_from_command, AgentDetection};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;
use portable_pty::MasterPty;
use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[path = "session_cwd.rs"]
mod cwd;
#[path = "session_process.rs"]
mod process;

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
}

impl TerminalSession {
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

        let session = make_session();
        assert!(session
            .observe_agent_commands(b"claudex --resume")
            .is_empty());
        let detections = session.observe_agent_commands(b"\r");
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].provider, "claudex");
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
