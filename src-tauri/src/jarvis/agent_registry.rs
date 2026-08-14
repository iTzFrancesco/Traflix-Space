use crate::jarvis::runtime_detector::{detect_from_command, normalize_provider};
use crate::jarvis::types::{
    AgentActivityEvent, AgentActivityKind, AgentCompletionNotification, AgentInteractionSource,
    AgentResult, AgentSessionRef, AgentState, AgentTaskContext, AgentTurnContext, Provenance,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const MAX_TERMINAL_FALLBACK_BYTES: usize = 32 * 1024;
pub const MAX_TASK_TEXT_BYTES: usize = 2048;
pub const MAX_ACTIVITY_TIMELINE: usize = 32;
const MAX_ACTIVITY_EXCERPT_BYTES: usize = 160;
const MAX_INPUT_BUFFER_BYTES: usize = 8 * 1024;
const MAX_INPUT_TRACKERS: usize = 128;
/// `agent.activity` limit bounds: default 8, hard maximum 16.
pub const MAX_ACTIVITY_LIMIT: usize = 16;
pub const DEFAULT_ACTIVITY_LIMIT: usize = 8;
const MAX_RETAINED_SESSIONS: usize = 256;
const MAX_TERMINAL_HISTORY: usize = 20;
const MAX_COMPLETION_KEYS: usize = 4096;
/// Output-driven `lastActivityAt`/`working` updates are throttled to at most
/// one per second per session so PTY chunks never grow the timeline.
const OUTPUT_ACTIVITY_THROTTLE_SECS: u64 = 1;

/// A `working` activity is only appended when the previous one is older than
/// this window, otherwise it would dominate the bounded timeline.
const WORKING_ACTIVITY_MIN_GAP_SECS: u64 = 10;
static NEXT_ACTIVITY_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq)]
pub struct TerminalAgentSnapshot {
    pub terminal_id: String,
    pub workspace_id: String,
    pub is_agent_terminal: bool,
    pub agent_id: Option<String>,
    pub agent_alias: Option<String>,
    pub observed_provider: Option<String>,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
    pub generation: u64,
    pub process_id: Option<u32>,
    pub process_alive: bool,
    /// Presence of the provider process below the long-lived PTY shell.
    /// `None` means that the process-tree observer has not established a
    /// state yet; it must not be confused with `process_alive`, which is the
    /// shell/PTY lifetime.
    pub agent_process_alive: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionObservation {
    pub provider: String,
    pub event_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTerminalText {
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct AgentRegistryStatus {
    pub objective: Option<String>,
    pub state: AgentState,
    pub last_turn: Option<AgentTurnContext>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub provenance: Provenance,
    pub confidence: f32,
    pub warnings: Vec<String>,
    pub current_task: Option<AgentTaskContext>,
    pub last_activity_at: Option<String>,
    #[cfg(test)]
    pub activity_timeline: Vec<AgentActivityEvent>,
}

#[derive(Debug, Clone)]
struct AgentSessionRecord {
    reference: AgentSessionRef,
    objective: Option<String>,
    state: AgentState,
    last_turn: Option<AgentTurnContext>,
    completion_notification: Option<AgentCompletionNotification>,
    last_result: Option<AgentResult>,
    provenance: Provenance,
    confidence: f32,
    warnings: Vec<String>,
    current_task: Option<AgentTaskContext>,
    last_activity_at: Option<String>,
    activity_timeline: VecDeque<AgentActivityEvent>,
}

impl AgentSessionRecord {
    fn push_activity(&mut self, event: AgentActivityEvent) {
        self.activity_timeline.push_back(event);
        while self.activity_timeline.len() > MAX_ACTIVITY_TIMELINE {
            self.activity_timeline.pop_front();
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedIdentity {
    observed_provider: Option<String>,
    resolved_provider: String,
    detection_source: String,
    detection_confidence: f32,
    identity_warnings: Vec<String>,
    identity_needs_confirmation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityDecision {
    Confirmed,
    Ignored,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct IdentityDecisionKey {
    terminal_id: String,
    generation: u64,
    provider: String,
}

#[derive(Default)]
struct BoundedCompletionKeys {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl BoundedCompletionKeys {
    fn accept(&mut self, key: String) -> bool {
        if self.set.contains(&key) {
            return false;
        }
        self.set.insert(key.clone());
        self.order.push_back(key);
        while self.order.len() > MAX_COMPLETION_KEYS {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
        true
    }
}

#[derive(Default)]
pub struct AgentSessionRegistry {
    sessions: Mutex<HashMap<String, AgentSessionRecord>>,
    completion_keys: Mutex<BoundedCompletionKeys>,
    identity_decisions: Mutex<HashMap<IdentityDecisionKey, IdentityDecision>>,
    selected_session: Mutex<Option<String>>,
    input_trackers: Mutex<HashMap<(String, u64), InputTracker>>,
    session_epochs: Mutex<HashMap<(String, u64), u64>>,
    dispatch_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// Bounded per-`(terminalId, generation)` tracker that reconstructs only the
/// current input line of the shared visible TUI. It never treats terminal
/// output as input (output never reaches this tracker) and it never invents a
/// task when reconstruction is not reliable.
#[derive(Debug, Clone, Default)]
struct InputTracker {
    text: String,
    escape: Vec<u8>,
    bracketed_paste: bool,
    /// Once cursor/editing semantics become unknowable, ignore the rest of
    /// the line until the next Enter/Ctrl+C boundary. Resetting and then
    /// collecting a suffix would fabricate a task that the user never typed.
    unreliable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TrackerSignal {
    /// Enter/CR committed a non-empty, reliably reconstructed input line.
    Committed(String),
    /// Ctrl+C observed; the current line (if any) was reset.
    Interrupted,
}

impl InputTracker {
    fn reset(&mut self) {
        self.text.clear();
        self.escape.clear();
        self.bracketed_paste = false;
        self.unreliable = false;
    }

    fn invalidate_line(&mut self) {
        self.text.clear();
        self.escape.clear();
        self.bracketed_paste = false;
        self.unreliable = true;
    }

    fn pop_char(&mut self) {
        if !self.unreliable {
            self.text.pop();
        }
    }

    fn push_char(&mut self, ch: char) {
        if self.unreliable {
            return;
        }
        if self.text.len() + ch.len_utf8() > MAX_INPUT_BUFFER_BYTES {
            // The line is too long to reconstruct reliably. Keep it invalid
            // until a commit/reset boundary; never resume from a suffix.
            self.invalidate_line();
            return;
        }
        self.text.push(ch);
    }

    fn flush_printable(&mut self, printable: &mut Vec<u8>) {
        if printable.is_empty() {
            return;
        }
        if self.unreliable {
            printable.clear();
            return;
        }
        for ch in String::from_utf8_lossy(&printable).chars() {
            self.push_char(ch);
            if self.unreliable {
                break;
            }
        }
        printable.clear();
    }

    fn finish_escape(&mut self, printable: &mut Vec<u8>) {
        let escape = std::mem::take(&mut self.escape);
        match escape.as_slice() {
            b"\x1b[200~" => self.bracketed_paste = true,
            b"\x1b[201~" => self.bracketed_paste = false,
            b"\x1b[3~" => {
                // Delete without cursor position: treated like backspace so
                // stale text cannot become a task.
                self.flush_printable(printable);
                self.pop_char();
            }
            _ => {
                // Arrow keys, Home/End, Alt sequences and other editing move
                // the cursor in ways this bounded tracker cannot reconstruct.
                // Invalidate the entire line until Enter/Ctrl+C instead of
                // resetting and accidentally committing only a later suffix.
                self.flush_printable(printable);
                self.invalidate_line();
            }
        }
    }

    fn feed(&mut self, data: &[u8]) -> Vec<TrackerSignal> {
        let mut signals = Vec::new();
        let mut printable: Vec<u8> = Vec::new();
        for &byte in data {
            if self.unreliable {
                // A boundary makes the next line trustworthy again. Everything
                // else belongs to the line we deliberately stopped tracking.
                if matches!(byte, b'\r' | b'\n' | 0x03) {
                    self.reset();
                }
                continue;
            }
            if !self.escape.is_empty() {
                self.escape.push(byte);
                if self.escape.len() > 32 {
                    self.invalidate_line();
                } else if self.escape.len() >= 3 && (0x40..=0x7e).contains(&byte) {
                    self.finish_escape(&mut printable);
                }
                continue;
            }
            if byte == 0x1b {
                self.flush_printable(&mut printable);
                self.escape.push(byte);
                continue;
            }
            match byte {
                b'\r' | b'\n' => {
                    self.flush_printable(&mut printable);
                    if self.unreliable {
                        self.reset();
                    } else if self.bracketed_paste {
                        // Pasted content may contain newlines; the paste block
                        // commits only after its closing marker plus Enter.
                        self.text.push('\n');
                    } else if !self.text.is_empty() {
                        let text = std::mem::take(&mut self.text);
                        self.escape.clear();
                        self.bracketed_paste = false;
                        signals.push(TrackerSignal::Committed(text));
                    } else {
                        self.escape.clear();
                    }
                }
                b'\x08' | b'\x7f' => {
                    self.flush_printable(&mut printable);
                    self.pop_char();
                }
                0x03 => {
                    self.flush_printable(&mut printable);
                    let had_line = !self.text.is_empty() || self.bracketed_paste;
                    self.reset();
                    if had_line {
                        signals.push(TrackerSignal::Interrupted);
                    }
                }
                _ if byte.is_ascii_control() => {
                    // Other control characters (e.g. Tab used for completion)
                    // cannot be reconstructed faithfully: invalidate the whole
                    // line until the next boundary.
                    self.flush_printable(&mut printable);
                    self.invalidate_line();
                }
                _ => printable.push(byte),
            }
        }
        self.flush_printable(&mut printable);
        signals
    }
}

impl AgentSessionRegistry {
    pub fn control_allowed(&self, terminal_id: &str, generation: u64) -> bool {
        let Ok(sessions) = self.sessions.lock() else {
            return false;
        };
        let providers = sessions
            .values()
            .filter(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id)
                    && record.reference.generation == generation
                    && !record.reference.identity_needs_confirmation
                    && record.state != AgentState::Exited
            })
            .map(|record| record.reference.resolved_provider.clone())
            .collect::<Vec<_>>();
        drop(sessions);
        providers.into_iter().any(|provider| {
            self.identity_decision(terminal_id, generation, &provider)
                != Some(IdentityDecision::Ignored)
        })
    }

    /// Validate the exact session selected by a binding. This is deliberately
    /// stricter than `control_allowed`: a live terminal with the same title or
    /// provider is never an acceptable substitute for a stale session.
    pub fn validate_session_binding(
        &self,
        terminal: &TerminalAgentSnapshot,
        expected_session_id: &str,
        expected_alias: &str,
        expected_provider: &str,
    ) -> Result<(), String> {
        if self.current_session_id(terminal) != expected_session_id {
            return Err("agent_session_stale".to_string());
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "agent_registry_unavailable".to_string())?;
        let record = sessions
            .get(expected_session_id)
            .ok_or_else(|| "agent_session_not_found".to_string())?;
        if record.state == AgentState::Exited
            || record.reference.workspace_id != terminal.workspace_id
            || record.reference.terminal_id.as_deref() != Some(terminal.terminal_id.as_str())
            || record.reference.generation != terminal.generation
        {
            return Err("agent_session_stale".to_string());
        }
        if record.reference.agent_alias.as_deref() != Some(expected_alias) {
            return Err("agent_alias_mismatch".to_string());
        }
        let provider = normalize_observed_provider(expected_provider)
            .unwrap_or_else(|| expected_provider.trim().to_ascii_lowercase());
        if record.reference.resolved_provider != provider {
            return Err("agent_provider_mismatch".to_string());
        }
        if record.reference.identity_needs_confirmation
            || self.identity_decision(
                &terminal.terminal_id,
                terminal.generation,
                &record.reference.resolved_provider,
            ) == Some(IdentityDecision::Ignored)
        {
            return Err("agent_identity_unconfirmed".to_string());
        }
        Ok(())
    }

    /// Per-alias mutex used to serialize prompt writes. The lock key is the
    /// internal alias, never the mutable display title.
    pub fn dispatch_lock(&self, alias: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .dispatch_locks
            .lock()
            .expect("agent dispatch lock registry poisoned");
        locks
            .entry(alias.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn observe_terminal_started(
        &self,
        terminal: &TerminalAgentSnapshot,
        observed_at: &str,
    ) -> Option<AgentSessionRef> {
        if terminal.workspace_id.trim().is_empty() {
            return None;
        }
        if !terminal.is_agent_terminal && terminal.observed_provider.is_none() {
            return None;
        }
        let identity = identity_from_snapshot(terminal);
        let epoch_key = (terminal.terminal_id.clone(), terminal.generation);
        let Ok(mut epochs) = self.session_epochs.lock() else {
            return None;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return None;
        };
        let epoch = epochs.entry(epoch_key).or_default();
        let mut session_id = session_id_for_epoch(terminal, *epoch);
        if terminal.process_alive
            && sessions
                .get(&session_id)
                .is_some_and(|record| record.state == AgentState::Exited)
        {
            *epoch = epoch.saturating_add(1);
            session_id = session_id_for_epoch(terminal, *epoch);
        }
        drop(epochs);
        mark_previous_generations_exited(&mut sessions, terminal, &session_id, observed_at);
        let record = sessions.entry(session_id.clone()).or_insert_with(|| {
            let state = if terminal.process_alive {
                AgentState::Starting
            } else {
                AgentState::Exited
            };
            AgentSessionRecord {
                reference: AgentSessionRef {
                    agent_session_id: session_id,
                    provider: identity.resolved_provider.clone(),
                    configured_agent_id: terminal.agent_id.clone(),
                    observed_provider: identity.observed_provider.clone(),
                    resolved_provider: identity.resolved_provider.clone(),
                    detection_source: identity.detection_source.clone(),
                    detection_confidence: identity.detection_confidence,
                    identity_warnings: identity.identity_warnings.clone(),
                    identity_needs_confirmation: identity.identity_needs_confirmation,
                    workspace_id: terminal.workspace_id.clone(),
                    terminal_id: Some(terminal.terminal_id.clone()),
                    agent_alias: terminal.agent_alias.clone(),
                    terminal_title: None,
                    generation: terminal.generation,
                    provider_session_id: None,
                    provider_turn_id: None,
                    created_at: observed_at.to_string(),
                    updated_at: observed_at.to_string(),
                    current_task: None,
                    last_activity_at: None,
                },
                objective: None,
                state,
                last_turn: None,
                completion_notification: None,
                last_result: None,
                provenance: registry_provenance(observed_at),
                confidence: 0.75,
                warnings: identity.identity_warnings.clone(),
                current_task: None,
                last_activity_at: None,
                activity_timeline: VecDeque::new(),
            }
        });
        update_identity_from_snapshot(record, terminal, &identity);
        if let Some(provider) = identity.observed_provider.as_deref() {
            if self
                .identity_decision(&terminal.terminal_id, terminal.generation, provider)
                .is_some()
            {
                record.reference.identity_needs_confirmation = false;
            }
        }
        record.reference.updated_at = observed_at.to_string();
        record.state = if terminal.process_alive {
            match record.state {
                AgentState::Starting
                    if identity_source_priority(&record.reference.detection_source) >= 4 =>
                {
                    AgentState::Waiting
                }
                AgentState::Exited if record.current_task.is_some() => AgentState::Working,
                AgentState::Exited => AgentState::Waiting,
                current => current,
            }
        } else {
            AgentState::Exited
        };
        let reference = record.reference.clone();
        self.prune_sessions_locked(&mut sessions);
        Some(reference)
    }

    #[cfg(test)]
    pub fn observe_input(&self, terminal: &TerminalAgentSnapshot, observed_at: &str) {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(record) = sessions.get_mut(&reference.agent_session_id) {
            record.state = AgentState::Working;
            record.reference.updated_at = observed_at.to_string();
            record.last_activity_at = Some(observed_at.to_string());
        }
    }

    /// Observe raw bytes typed/pasted by the user into the shared visible TUI.
    /// Only committed (Enter) input can become a task; output never reaches
    /// this method. Jarvis writes use [`Self::observe_jarvis_send`] instead so
    /// their provenance stays distinct.
    pub fn observe_user_input(
        &self,
        terminal: &TerminalAgentSnapshot,
        data: &[u8],
        observed_at: &str,
    ) {
        let Some(mut reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        let Ok(mut trackers) = self.input_trackers.lock() else {
            return;
        };
        let key = (terminal.terminal_id.clone(), terminal.generation);
        let tracker = trackers.entry(key.clone()).or_default();
        let signals = tracker.feed(data);
        if trackers.len() > MAX_INPUT_TRACKERS {
            self.prune_input_trackers_locked(&mut trackers);
        }
        drop(trackers);

        for signal in signals {
            match signal {
                TrackerSignal::Committed(text) => {
                    if is_agent_launch_command(&text) {
                        // Launching the CLI is session startup, not a task.
                        continue;
                    }
                    if is_session_reset_command(&text) {
                        self.begin_new_session_epoch(terminal, observed_at);
                        if let Some(next) = self.observe_terminal_started(terminal, observed_at) {
                            reference = next;
                        }
                        continue;
                    }
                    let local_command = is_local_agent_command(&text);
                    let excerpt = bounded_excerpt(&text, MAX_ACTIVITY_EXCERPT_BYTES);
                    let Ok(mut sessions) = self.sessions.lock() else {
                        return;
                    };
                    let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
                        continue;
                    };
                    record.reference.updated_at = observed_at.to_string();
                    record.last_activity_at = Some(observed_at.to_string());
                    if local_command {
                        // Slash commands are real activity but do not imply a
                        // new work turn and never replace the main task/state.
                        record.push_activity(activity_event(
                            AgentActivityKind::PromptSubmitted,
                            AgentInteractionSource::User,
                            observed_at,
                            Some(excerpt),
                            0.7,
                            true,
                        ));
                    } else {
                        record.state = AgentState::Working;
                        record.current_task = Some(AgentTaskContext {
                            text: bounded_task_text(&text),
                            source: AgentInteractionSource::User,
                            started_at: observed_at.to_string(),
                            completed_at: None,
                            confidence: 0.65,
                            untrusted: true,
                        });
                        record.push_activity(activity_event(
                            AgentActivityKind::PromptSubmitted,
                            AgentInteractionSource::User,
                            observed_at,
                            Some(excerpt),
                            0.65,
                            true,
                        ));
                    }
                    sync_reference_enrichment(record);
                }
                TrackerSignal::Interrupted => {
                    let Ok(mut sessions) = self.sessions.lock() else {
                        return;
                    };
                    let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
                        continue;
                    };
                    record.last_activity_at = Some(observed_at.to_string());
                    // A Ctrl+C may abort a running turn or only clear the
                    // line; without proof we never mark the task completed.
                    record.push_activity(activity_event(
                        AgentActivityKind::Interrupted,
                        AgentInteractionSource::User,
                        observed_at,
                        None,
                        0.6,
                        true,
                    ));
                    sync_reference_enrichment(record);
                }
            }
        }
    }

    /// Record a task originated by Jarvis. The caller must invoke this only
    /// AFTER a successful PTY write of a confirmed Pending Action; generation
    /// and liveness are re-validated by the caller before the write.
    pub fn observe_jarvis_send(
        &self,
        terminal: &TerminalAgentSnapshot,
        text: &str,
        observed_at: &str,
    ) {
        let session_id = self.current_session_id(terminal);
        let _ = self.observe_jarvis_send_for_session(terminal, &session_id, text, observed_at);
    }

    /// Record a Jarvis task only for the exact session that was validated by
    /// the dispatcher. A new session on the same terminal is an error, not a
    /// reason to silently rebind the follow-up.
    pub fn observe_jarvis_send_for_session(
        &self,
        terminal: &TerminalAgentSnapshot,
        expected_session_id: &str,
        text: &str,
        observed_at: &str,
    ) -> Result<(), String> {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return Err("agent_session_not_found".to_string());
        };
        if reference.agent_session_id != expected_session_id {
            return Err("agent_session_stale".to_string());
        }
        let excerpt = bounded_excerpt(text, MAX_ACTIVITY_EXCERPT_BYTES);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "agent_registry_unavailable".to_string())?;
        let record = sessions
            .get_mut(&reference.agent_session_id)
            .ok_or_else(|| "agent_session_not_found".to_string())?;
        record.state = AgentState::Working;
        record.reference.updated_at = observed_at.to_string();
        record.last_activity_at = Some(observed_at.to_string());
        record.current_task = Some(AgentTaskContext {
            text: bounded_task_text(text),
            source: AgentInteractionSource::Jarvis,
            started_at: observed_at.to_string(),
            completed_at: None,
            // The backend knows exactly which bytes were written.
            confidence: 0.95,
            untrusted: false,
        });
        record.push_activity(activity_event(
            AgentActivityKind::PromptSubmitted,
            AgentInteractionSource::Jarvis,
            observed_at,
            Some(excerpt),
            0.95,
            false,
        ));
        sync_reference_enrichment(record);
        Ok(())
    }

    /// Record a confirmed, successfully written `agent.abort` (Ctrl+C). The
    /// task is intentionally NOT marked completed: without proof, we only
    /// record the interruption.
    pub fn observe_abort(&self, terminal: &TerminalAgentSnapshot, observed_at: &str) {
        let Some(reference) = self.observe_terminal_started(terminal, observed_at) else {
            return;
        };
        if let Ok(mut trackers) = self.input_trackers.lock() {
            trackers.remove(&(terminal.terminal_id.clone(), terminal.generation));
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
            return;
        };
        record.last_activity_at = Some(observed_at.to_string());
        record.push_activity(activity_event(
            AgentActivityKind::Interrupted,
            AgentInteractionSource::Jarvis,
            observed_at,
            None,
            0.9,
            false,
        ));
        sync_reference_enrichment(record);
    }

    fn begin_new_session_epoch(&self, terminal: &TerminalAgentSnapshot, observed_at: &str) {
        let key = (terminal.terminal_id.clone(), terminal.generation);
        let Ok(mut epochs) = self.session_epochs.lock() else {
            return;
        };
        let epoch = epochs.entry(key).or_default();
        *epoch = epoch.saturating_add(1);
        let next_session_id = session_id_for_epoch(terminal, *epoch);
        drop(epochs);

        if let Ok(mut sessions) = self.sessions.lock() {
            for record in sessions.values_mut() {
                if record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
                    && record.reference.generation == terminal.generation
                    && record.reference.agent_session_id != next_session_id
                    && record.state != AgentState::Exited
                {
                    record.state = AgentState::Exited;
                    record.reference.identity_needs_confirmation = false;
                    record.reference.updated_at = observed_at.to_string();
                    record.last_activity_at = Some(observed_at.to_string());
                    record.push_activity(activity_event(
                        AgentActivityKind::Exited,
                        AgentInteractionSource::System,
                        observed_at,
                        Some("agent session reset".to_string()),
                        1.0,
                        false,
                    ));
                    sync_reference_enrichment(record);
                }
            }
        }
        self.observe_terminal_started(terminal, observed_at);
    }

    pub fn current_session_id(&self, terminal: &TerminalAgentSnapshot) -> String {
        let epoch = self
            .session_epochs
            .lock()
            .ok()
            .and_then(|epochs| {
                epochs
                    .get(&(terminal.terminal_id.clone(), terminal.generation))
                    .copied()
            })
            .unwrap_or_default();
        session_id_for_epoch(terminal, epoch)
    }

    /// Throttled (max once per second per session) update of `lastActivityAt`
    /// from terminal output. Output is never stored and never becomes a task.
    pub fn observe_output(&self, terminal_id: &str, generation: u64, observed_at: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if record.reference.terminal_id.as_deref() != Some(terminal_id)
                || record.reference.generation != generation
                || record.state == AgentState::Exited
            {
                continue;
            }
            let due = record.last_activity_at.as_deref().is_none_or(|last| {
                seconds_since(last, observed_at) >= OUTPUT_ACTIVITY_THROTTLE_SECS
            });
            if due {
                record.last_activity_at = Some(observed_at.to_string());
            }
            break;
        }
    }

    /// Test seam: output silence is diagnostic only and never proves that a
    /// turn completed. Production has no idle-completion watcher.
    #[cfg(test)]
    fn mark_idle_sessions_completed(&self, observed_at: &str) -> Vec<String> {
        let _ = observed_at;
        Vec::new()
    }

    /// Append a throttled `working` activity while the user is actively
    /// typing into a session that already has a task.
    pub fn observe_user_typing(
        &self,
        terminal: &TerminalAgentSnapshot,
        data: &[u8],
        observed_at: &str,
    ) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(record) = sessions.values_mut().find(|record| {
            record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
                && record.reference.generation == terminal.generation
                && record.state != AgentState::Exited
        }) else {
            return;
        };
        if record.current_task.is_none() || data.is_empty() {
            return;
        }
        record.last_activity_at = Some(observed_at.to_string());
        let working_due = record.activity_timeline.back().map_or(true, |last| {
            last.kind != AgentActivityKind::Working
                || seconds_since(&last.occurred_at, observed_at) >= WORKING_ACTIVITY_MIN_GAP_SECS
        });
        if working_due {
            record.push_activity(activity_event(
                AgentActivityKind::Working,
                AgentInteractionSource::User,
                observed_at,
                None,
                0.5,
                true,
            ));
        }
    }

    pub fn activity(
        &self,
        reference: &AgentSessionRef,
        limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, crate::jarvis::agent_adapter::AgentSourceError> {
        let limit = limit.clamp(1, MAX_ACTIVITY_LIMIT);
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        let record = sessions
            .get(&reference.agent_session_id)
            .filter(|record| record.reference.workspace_id == reference.workspace_id)
            .ok_or_else(|| crate::jarvis::agent_adapter::AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })?;
        Ok(record
            .activity_timeline
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect())
    }

    fn prune_input_trackers_locked(&self, trackers: &mut HashMap<(String, u64), InputTracker>) {
        let Ok(sessions) = self.sessions.lock() else {
            return;
        };
        trackers.retain(|(terminal_id, generation), _| {
            sessions.values().any(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id.as_str())
                    && record.reference.generation == *generation
            })
        });
    }

    pub fn observe_completion(
        &self,
        terminal: &TerminalAgentSnapshot,
        observation: CompletionObservation,
        result: Option<AgentResult>,
        observed_at: &str,
    ) -> bool {
        if let Some(key) = completion_key(terminal, &observation) {
            let Ok(mut keys) = self.completion_keys.lock() else {
                return false;
            };
            if !keys.accept(key) {
                return false;
            }
        }

        let mut completion_terminal = terminal.clone();
        completion_terminal.is_agent_terminal = true;
        completion_terminal.observed_provider = normalize_observed_provider(&observation.provider);
        completion_terminal.detection_source = "completion-event".to_string();
        completion_terminal.detection_confidence = 1.0;
        if let Some(provider) = completion_terminal.observed_provider.as_deref() {
            self.clear_identity_decision(
                &completion_terminal.terminal_id,
                completion_terminal.generation,
                provider,
            );
        }
        if let Some(provider_session_id) = observation
            .provider_session_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            self.rotate_epoch_for_provider_session_change(
                &completion_terminal,
                provider_session_id,
                observed_at,
            );
        }
        let reference = self.observe_terminal_started(&completion_terminal, observed_at);
        let Some(reference) = reference else {
            return false;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        let Some(record) = sessions.get_mut(&reference.agent_session_id) else {
            return false;
        };

        record.reference.provider_session_id = observation.provider_session_id.clone();
        record.reference.provider_turn_id = observation.provider_turn_id.clone();
        if let Some(observed_provider) = normalize_observed_provider(&observation.provider) {
            if let Some(configured) = record.reference.configured_agent_id.as_deref() {
                if normalize_provider(configured).as_deref() != Some(observed_provider.as_str()) {
                    let warning = format!(
                        "Identity mismatch: configured agent '{}' but observed provider '{}'",
                        configured, observed_provider
                    );
                    push_warning(&mut record.reference.identity_warnings, &warning);
                    push_warning(&mut record.warnings, &warning);
                }
            }
            record.reference.observed_provider = Some(observed_provider.clone());
            record.reference.resolved_provider = observed_provider.clone();
            record.reference.provider = observed_provider;
            record.reference.detection_source = "completion-event".to_string();
            record.reference.detection_confidence = 1.0;
            record.reference.identity_needs_confirmation = false;
        }
        record.reference.updated_at = observed_at.to_string();
        record.state = AgentState::Waiting;
        record.last_activity_at = Some(observed_at.to_string());
        if let Some(task) = record.current_task.as_mut() {
            task.completed_at = Some(observed_at.to_string());
        }
        record.push_activity(activity_event(
            AgentActivityKind::CompletionObserved,
            AgentInteractionSource::System,
            observed_at,
            None,
            1.0,
            true,
        ));
        sync_reference_enrichment(record);
        record.last_turn = Some(AgentTurnContext {
            turn_id: observation.provider_turn_id,
            state: AgentState::Waiting,
            objective: record.objective.clone(),
            occurred_at: observation.occurred_at,
            untrusted: true,
        });
        record.completion_notification = Some(AgentCompletionNotification {
            event_id: observation.event_id,
            observed_at: observed_at.to_string(),
            result_available: result.is_some(),
            untrusted: true,
        });
        let result_available = result.is_some();
        if result_available {
            record.last_result = result;
            record.push_activity(activity_event(
                AgentActivityKind::ResultAvailable,
                AgentInteractionSource::System,
                observed_at,
                None,
                0.35,
                true,
            ));
        }
        if result_available {
            push_warning(
                &mut record.warnings,
                "Result captured from terminal fallback; structured messages unavailable",
            );
        } else {
            push_warning(
                &mut record.warnings,
                "completion observed, result unavailable",
            );
        }
        self.prune_sessions_locked(&mut sessions);
        true
    }

    fn rotate_epoch_for_provider_session_change(
        &self,
        terminal: &TerminalAgentSnapshot,
        provider_session_id: &str,
        observed_at: &str,
    ) {
        let current_id = self.current_session_id(terminal);
        let changed = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&current_id).cloned())
            .and_then(|record| record.reference.provider_session_id)
            .is_some_and(|current| current != provider_session_id);
        if changed {
            self.begin_new_session_epoch(terminal, observed_at);
        }
    }

    pub fn observe_terminal_exit(&self, terminal_id: &str, generation: u64, observed_at: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if record.reference.terminal_id.as_deref() == Some(terminal_id)
                && record.reference.generation == generation
            {
                record.state = AgentState::Exited;
                // An exited terminal cannot be controlled. Clear any pending
                // manual identity gate so stale history never appears as an
                // actionable confirmation request after the PTY is closed.
                record.reference.identity_needs_confirmation = false;
                record.reference.updated_at = observed_at.to_string();
                record.last_activity_at = Some(observed_at.to_string());
                record.push_activity(activity_event(
                    AgentActivityKind::Exited,
                    AgentInteractionSource::System,
                    observed_at,
                    None,
                    1.0,
                    true,
                ));
                sync_reference_enrichment(record);
            }
        }
        self.prune_sessions_locked(&mut sessions);
    }

    pub fn reconcile(&self, terminals: &[TerminalAgentSnapshot], observed_at: &str) {
        for terminal in terminals {
            if terminal.is_agent_terminal || terminal.observed_provider.is_some() {
                self.observe_terminal_started(terminal, observed_at);
            }
        }

        let known: HashSet<(String, u64)> = terminals
            .iter()
            .filter(|terminal| terminal.is_agent_terminal || terminal.observed_provider.is_some())
            .map(|terminal| (terminal.terminal_id.clone(), terminal.generation))
            .collect();
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for record in sessions.values_mut() {
            if let Some(terminal_id) = record.reference.terminal_id.as_deref() {
                let key = (terminal_id.to_string(), record.reference.generation);
                if !known.contains(&key) && record.state != AgentState::Exited {
                    record.state = AgentState::Exited;
                    record.reference.identity_needs_confirmation = false;
                    record.reference.updated_at = observed_at.to_string();
                }
            }
        }
        self.prune_sessions_locked(&mut sessions);
    }

    pub fn list_sessions(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AgentSessionRef>, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        let mut result = sessions
            .values()
            .filter(|record| record.reference.workspace_id == workspace_id)
            .map(|record| record.reference.clone())
            .collect::<Vec<_>>();
        result.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.agent_session_id.cmp(&right.agent_session_id))
        });
        Ok(result)
    }

    pub fn status(
        &self,
        reference: &AgentSessionRef,
    ) -> Result<AgentRegistryStatus, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        let record = sessions
            .get(&reference.agent_session_id)
            .filter(|record| record.reference.workspace_id == reference.workspace_id)
            .ok_or_else(|| crate::jarvis::agent_adapter::AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })?;
        Ok(AgentRegistryStatus {
            objective: record.objective.clone(),
            state: record.state,
            last_turn: record.last_turn.clone(),
            completion_notification: record.completion_notification.clone(),
            provenance: record.provenance.clone(),
            confidence: record.confidence,
            warnings: record.warnings.clone(),
            current_task: record.current_task.clone(),
            last_activity_at: record.last_activity_at.clone(),
            #[cfg(test)]
            activity_timeline: record.activity_timeline.iter().cloned().collect(),
        })
    }

    pub fn last_result(
        &self,
        reference: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, crate::jarvis::agent_adapter::AgentSourceError> {
        let sessions = self.sessions.lock().map_err(|_| {
            crate::jarvis::agent_adapter::AgentSourceError::unavailable("registry lock unavailable")
        })?;
        sessions
            .get(&reference.agent_session_id)
            .filter(|record| record.reference.workspace_id == reference.workspace_id)
            .map(|record| record.last_result.clone())
            .ok_or_else(|| crate::jarvis::agent_adapter::AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })
    }

    pub fn set_identity_decision(
        &self,
        terminal_id: &str,
        generation: u64,
        provider: &str,
        decision: IdentityDecision,
    ) {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        if key.provider.is_empty() {
            return;
        }
        if let Ok(mut decisions) = self.identity_decisions.lock() {
            decisions.insert(key.clone(), decision);
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(record) = sessions.values_mut().find(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id)
                    && record.reference.generation == generation
                    && record.reference.resolved_provider == key.provider
            }) {
                record.reference.identity_needs_confirmation = false;
            }
        }
    }

    pub fn clear_identity_decision(&self, terminal_id: &str, generation: u64, provider: &str) {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        if let Ok(mut decisions) = self.identity_decisions.lock() {
            decisions.remove(&key);
        }
    }

    /// Confirm the identity of a terminal on behalf of the human user.
    /// Called when the user explicitly confirms an action (send/abort)
    /// targeting a terminal whose identity is still unconfirmed — e.g. a
    /// manually launched agent detected from its launch command
    /// (command-observed, confidence below the 0.75 confirmation gate).
    /// Returns `true` when a matching unconfirmed record was found and
    /// unblocked. A prior `Ignored` decision is not overridden.
    pub fn confirm_identity_for_terminal(&self, terminal_id: &str, generation: u64) -> bool {
        let provider = {
            let Ok(sessions) = self.sessions.lock() else {
                return false;
            };
            let Some(record) = sessions.values().find(|record| {
                record.reference.terminal_id.as_deref() == Some(terminal_id)
                    && record.reference.generation == generation
                    && record.reference.identity_needs_confirmation
                    && record.state != AgentState::Exited
            }) else {
                return false;
            };
            record
                .reference
                .observed_provider
                .clone()
                .or_else(|| Some(record.reference.resolved_provider.clone()))
        };
        let Some(provider) = provider else {
            return false;
        };
        self.set_identity_decision(
            terminal_id,
            generation,
            &provider,
            IdentityDecision::Confirmed,
        );
        true
    }

    pub fn mark_selected(&self, reference: &AgentSessionRef) {
        if let Ok(mut selected) = self.selected_session.lock() {
            *selected = Some(reference.agent_session_id.clone());
        }
    }

    fn identity_decision(
        &self,
        terminal_id: &str,
        generation: u64,
        provider: &str,
    ) -> Option<IdentityDecision> {
        let key = IdentityDecisionKey {
            terminal_id: terminal_id.to_string(),
            generation,
            provider: normalize_observed_provider(provider)
                .unwrap_or_else(|| provider.trim().to_ascii_lowercase()),
        };
        self.identity_decisions
            .lock()
            .ok()
            .and_then(|decisions| decisions.get(&key).copied())
    }

    fn prune_sessions_locked(&self, sessions: &mut HashMap<String, AgentSessionRecord>) {
        let selected = self
            .selected_session
            .lock()
            .ok()
            .and_then(|selected| selected.clone());
        prune_sessions(sessions, selected.as_deref());
    }
}

fn session_id_for_epoch(terminal: &TerminalAgentSnapshot, epoch: u64) -> String {
    format!(
        "agent-session:{}:{}:{}",
        terminal.terminal_id, terminal.generation, epoch
    )
}

fn identity_from_snapshot(terminal: &TerminalAgentSnapshot) -> ResolvedIdentity {
    let observed_provider = terminal
        .observed_provider
        .as_deref()
        .and_then(normalize_observed_provider);
    let configured_provider = terminal
        .agent_id
        .as_deref()
        .and_then(|value| {
            normalize_provider(value).or_else(|| Some(value.trim().to_ascii_lowercase()))
        })
        .filter(|value| !value.is_empty());
    let (resolved_provider, detection_source, detection_confidence) =
        if let Some(observed) = observed_provider.clone() {
            (
                observed,
                if terminal.detection_source.trim().is_empty() {
                    "runtime-detector".to_string()
                } else {
                    terminal.detection_source.clone()
                },
                terminal.detection_confidence.max(0.1),
            )
        } else if let Some(configured) = configured_provider {
            (configured, "configured-hint".to_string(), 0.65)
        } else {
            ("terminal-agent".to_string(), "fallback".to_string(), 0.2)
        };
    let mut identity_warnings = terminal.identity_warnings.clone();
    if let (Some(configured), Some(observed)) = (
        terminal.agent_id.as_deref().and_then(normalize_provider),
        observed_provider.as_deref(),
    ) {
        if configured != observed {
            push_warning(
                &mut identity_warnings,
                &format!(
                    "Identity mismatch: configured agent '{}' but observed provider '{}'",
                    configured, observed
                ),
            );
        }
    }
    let identity_needs_confirmation = observed_provider.is_some()
        && detection_source != "completion-event"
        && detection_confidence < 0.75;
    ResolvedIdentity {
        observed_provider,
        resolved_provider,
        detection_source,
        detection_confidence,
        identity_warnings,
        identity_needs_confirmation,
    }
}

fn normalize_observed_provider(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(normalize_provider(value).unwrap_or_else(|| value.to_ascii_lowercase()))
}

pub(crate) fn identity_source_priority(source: &str) -> u8 {
    match source {
        "completion-event" => 5,
        "backend-launch" => 4,
        "process-tree" => 4,
        "command-observed" => 3,
        "configured-hint" => 2,
        _ => 1,
    }
}

fn update_identity_from_snapshot(
    record: &mut AgentSessionRecord,
    terminal: &TerminalAgentSnapshot,
    identity: &ResolvedIdentity,
) {
    if terminal.agent_alias.is_some() {
        record.reference.agent_alias = terminal.agent_alias.clone();
    }
    if record.reference.configured_agent_id.is_none() {
        record.reference.configured_agent_id = terminal.agent_id.clone();
    }
    let current_priority = identity_source_priority(&record.reference.detection_source);
    let incoming_priority = identity_source_priority(&identity.detection_source);
    if incoming_priority >= current_priority
        && (identity.observed_provider.is_some() || record.reference.observed_provider.is_none())
    {
        record.reference.observed_provider = identity.observed_provider.clone();
        record.reference.resolved_provider = identity.resolved_provider.clone();
        record.reference.provider = identity.resolved_provider.clone();
        record.reference.detection_source = identity.detection_source.clone();
        record.reference.detection_confidence = identity.detection_confidence;
        record.reference.identity_needs_confirmation = identity.identity_needs_confirmation;
    }
    for warning in &identity.identity_warnings {
        push_warning(&mut record.reference.identity_warnings, warning);
        push_warning(&mut record.warnings, warning);
    }
}

fn prune_sessions(sessions: &mut HashMap<String, AgentSessionRecord>, selected: Option<&str>) {
    let mut by_terminal: HashMap<String, Vec<(u64, String, String)>> = HashMap::new();
    for record in sessions.values() {
        if record.state != AgentState::Exited
            || selected == Some(record.reference.agent_session_id.as_str())
        {
            continue;
        }
        let Some(terminal_id) = record.reference.terminal_id.as_ref() else {
            continue;
        };
        by_terminal.entry(terminal_id.clone()).or_default().push((
            record.reference.generation,
            record.reference.updated_at.clone(),
            record.reference.agent_session_id.clone(),
        ));
    }

    let mut remove = Vec::new();
    for (_, mut history) in by_terminal {
        history.sort();
        let keep_from = history.len().saturating_sub(MAX_TERMINAL_HISTORY);
        remove.extend(history.into_iter().take(keep_from).map(|(_, _, id)| id));
    }
    for id in remove {
        sessions.remove(&id);
    }

    if sessions.len() <= MAX_RETAINED_SESSIONS {
        return;
    }
    let mut candidates = sessions
        .values()
        .filter(|record| {
            record.state == AgentState::Exited
                && selected != Some(record.reference.agent_session_id.as_str())
        })
        .map(|record| {
            (
                record.reference.updated_at.clone(),
                record.reference.generation,
                record.reference.agent_session_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort();
    let remove_count = sessions.len().saturating_sub(MAX_RETAINED_SESSIONS);
    for (_, _, session_id) in candidates.into_iter().take(remove_count) {
        sessions.remove(&session_id);
    }
}

#[cfg(test)]
pub fn fallback_result_from_terminal(text: &str, observed_at: &str) -> Option<AgentResult> {
    fallback_result_from_terminal_with_truncation(text, false, observed_at)
}

pub fn fallback_result_from_terminal_with_truncation(
    text: &str,
    input_truncated: bool,
    observed_at: &str,
) -> Option<AgentResult> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_end_matches('\n');
    if normalized.trim().is_empty() {
        return None;
    }
    let truncated = input_truncated || normalized.len() > MAX_TERMINAL_FALLBACK_BYTES;
    let content = if truncated {
        let mut start = normalized.len() - MAX_TERMINAL_FALLBACK_BYTES;
        while !normalized.is_char_boundary(start) {
            start += 1;
        }
        normalized[start..].to_string()
    } else {
        normalized.to_string()
    };
    Some(AgentResult {
        content,
        truncated,
        untrusted: true,
        provenance: Provenance {
            source: "terminal-fallback".to_string(),
            observed_at: observed_at.to_string(),
            confidence: 0.35,
            untrusted: true,
        },
    })
}

fn mark_previous_generations_exited(
    sessions: &mut HashMap<String, AgentSessionRecord>,
    terminal: &TerminalAgentSnapshot,
    current_session_id: &str,
    observed_at: &str,
) {
    for record in sessions.values_mut() {
        if record.reference.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
            && record.reference.workspace_id == terminal.workspace_id
            && record.reference.agent_session_id != current_session_id
            && record.reference.generation != terminal.generation
        {
            record.state = AgentState::Exited;
            record.reference.identity_needs_confirmation = false;
            record.reference.updated_at = observed_at.to_string();
            record.last_activity_at = Some(observed_at.to_string());
            record.push_activity(activity_event(
                AgentActivityKind::Exited,
                AgentInteractionSource::System,
                observed_at,
                None,
                1.0,
                true,
            ));
            sync_reference_enrichment(record);
        }
    }
}

fn sync_reference_enrichment(record: &mut AgentSessionRecord) {
    record.reference.current_task = record.current_task.clone();
    record.reference.last_activity_at = record.last_activity_at.clone();
}

fn activity_event(
    kind: AgentActivityKind,
    source: AgentInteractionSource,
    occurred_at: &str,
    text_excerpt: Option<String>,
    confidence: f32,
    untrusted: bool,
) -> AgentActivityEvent {
    AgentActivityEvent {
        id: format!(
            "activity:{}-{}",
            std::process::id(),
            NEXT_ACTIVITY_ID.fetch_add(1, Ordering::Relaxed)
        ),
        kind,
        source,
        occurred_at: occurred_at.to_string(),
        text_excerpt,
        confidence,
        untrusted,
    }
}

fn bounded_task_text(text: &str) -> String {
    bounded_excerpt(text, MAX_TASK_TEXT_BYTES)
}

fn bounded_excerpt(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// A committed line that launches an agent CLI is session startup, never a
/// task. Reuses the runtime detector so the rule matches identity exactly.
fn is_agent_launch_command(text: &str) -> bool {
    detect_from_command(text).is_some()
}

/// Local TUI commands may become activity events but never replace the main
/// task. Session resets are handled separately.
fn is_local_agent_command(text: &str) -> bool {
    let first = text.split_whitespace().next().unwrap_or_default();
    let token = first
        .strip_prefix('/')
        .unwrap_or(first)
        .to_ascii_lowercase();
    matches!(token.as_str(), "model" | "help")
}

fn is_session_reset_command(text: &str) -> bool {
    let first = text.split_whitespace().next().unwrap_or_default();
    let Some(token) = first.strip_prefix('/') else {
        return false;
    };
    let token = token.to_ascii_lowercase();
    matches!(token.as_str(), "clear" | "new")
}

/// Approximate seconds between two RFC3339 timestamps produced by the same
/// clock. Used only for throttling decisions, never for absolute time.
fn seconds_since(earlier: &str, later: &str) -> u64 {
    let parse = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|dt| dt.timestamp())
    };
    match (parse(earlier), parse(later)) {
        (Some(a), Some(b)) => (b - a).max(0) as u64,
        _ => u64::MAX,
    }
}

fn completion_key(
    terminal: &TerminalAgentSnapshot,
    observation: &CompletionObservation,
) -> Option<String> {
    observation
        .event_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|event_id| {
            format!(
                "{}:{}:event:{}",
                terminal.terminal_id, terminal.generation, event_id
            )
        })
        .or_else(|| {
            let session = observation
                .provider_session_id
                .as_deref()
                .unwrap_or_default();
            let turn = observation.provider_turn_id.as_deref().unwrap_or_default();
            (!session.is_empty() || !turn.is_empty()).then(|| {
                format!(
                    "{}:{}:{}:{}",
                    terminal.terminal_id, terminal.generation, session, turn
                )
            })
        })
}

fn registry_provenance(observed_at: &str) -> Provenance {
    Provenance {
        source: "terminal-registry".to_string(),
        observed_at: observed_at.to_string(),
        confidence: 0.75,
        untrusted: true,
    }
}

fn push_warning(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::super::agent_adapter::{AgentContextSource, LiveAgentContextSource};
    use super::super::types::{
        AgentActivityKind, AgentInteractionSource, AgentResult, AgentState, AgentTaskContext,
        Provenance,
    };
    use super::{
        fallback_result_from_terminal, AgentSessionRegistry, CompletionObservation,
        IdentityDecision, TerminalAgentSnapshot, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT,
        MAX_ACTIVITY_TIMELINE, MAX_INPUT_BUFFER_BYTES, MAX_TASK_TEXT_BYTES,
    };

    fn terminal(generation: u64, alive: bool) -> TerminalAgentSnapshot {
        TerminalAgentSnapshot {
            terminal_id: "terminal-1".to_string(),
            workspace_id: "workspace-a".to_string(),
            is_agent_terminal: true,
            agent_id: Some("codex".to_string()),
            agent_alias: Some("codex-1".to_string()),
            observed_provider: None,
            detection_source: "configured-hint".to_string(),
            detection_confidence: 0.65,
            identity_warnings: Vec::new(),
            generation,
            process_id: Some(100),
            process_alive: alive,
            agent_process_alive: Some(alive),
        }
    }

    fn started(registry: &AgentSessionRegistry, generation: u64) {
        registry.observe_terminal_started(&terminal(generation, true), "2026-08-07T00:00:00Z");
    }

    #[test]
    fn agent_terminal_creates_a_session_but_normal_shell_does_not() {
        let registry = AgentSessionRegistry::default();
        let mut shell = terminal(1, true);
        shell.is_agent_terminal = false;
        shell.agent_id = None;
        registry.observe_terminal_started(&shell, "now");
        assert!(registry.list_sessions("workspace-a").unwrap().is_empty());

        started(&registry, 1);
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].provider, "codex");
        assert_eq!(sessions[0].generation, 1);
    }

    #[test]
    fn backend_owned_launch_is_control_ready_without_human_confirmation() {
        let registry = AgentSessionRegistry::default();
        let mut agent = terminal(1, true);
        agent.observed_provider = Some("codex".to_string());
        agent.detection_source = "backend-launch".to_string();
        agent.detection_confidence = 1.0;
        registry.observe_terminal_started(&agent, "2026-08-12T00:00:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(!session.identity_needs_confirmation);
        assert!(registry.control_allowed("terminal-1", 1));
    }

    #[test]
    fn sessions_are_isolated_and_generation_creates_a_new_identity() {
        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        let mut other = terminal(1, true);
        other.terminal_id = "terminal-2".to_string();
        other.workspace_id = "workspace-b".to_string();
        registry.observe_terminal_started(&other, "now");
        started(&registry, 2);

        let first = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(first.len(), 2);
        assert_ne!(first[0].agent_session_id, first[1].agent_session_id);
        assert_eq!(registry.list_sessions("workspace-b").unwrap().len(), 1);
        assert_eq!(
            registry.status(&first[0]).unwrap().state,
            AgentState::Exited
        );
    }

    #[test]
    fn input_and_completion_update_waiting_without_closing_the_session() {
        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        registry.observe_input(&terminal(1, true), "now");
        let observation = CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some("event-1".to_string()),
            provider_session_id: Some("provider-session".to_string()),
            provider_turn_id: Some("turn-1".to_string()),
            occurred_at: Some("2026-08-07T00:01:00Z".to_string()),
        };
        let result = Some(AgentResult {
            content: "done".to_string(),
            truncated: false,
            untrusted: true,
            provenance: Provenance {
                source: "terminal-fallback".to_string(),
                observed_at: "now".to_string(),
                confidence: 0.35,
                untrusted: true,
            },
        });
        assert!(registry.observe_completion(
            &terminal(1, true),
            observation.clone(),
            result,
            "now",
        ));
        assert!(!registry.observe_completion(&terminal(1, true), observation, None, "now"));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            session.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(session.provider_turn_id.as_deref(), Some("turn-1"));
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Waiting);
        assert_eq!(status.last_turn.unwrap().turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            registry.last_result(&session).unwrap().unwrap().content,
            "done"
        );

        registry.observe_input(&terminal(1, true), "later");
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Working
        );
        registry.observe_terminal_exit("terminal-1", 1, "exit");
        assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
    }

    #[test]
    fn fallback_is_normalized_bounded_and_untrusted() {
        let input = format!("first\r\nlast{}\r\n\r\n", "x".repeat(40_000));
        let result = fallback_result_from_terminal(&input, "now").unwrap();
        assert!(result.content.len() <= 32 * 1024);
        assert!(result.truncated);
        assert!(result.untrusted);
        assert_eq!(result.provenance.source, "terminal-fallback");
        assert!(result.provenance.confidence < 1.0);
        assert!(!result.content.ends_with('\n'));
    }

    #[test]
    fn live_source_exposes_registry_and_rejects_structured_messages() {
        let registry = std::sync::Arc::new(AgentSessionRegistry::default());
        started(&registry, 1);
        let source = LiveAgentContextSource::new(registry);
        let sessions = source.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            source.get_status(&sessions[0]).unwrap().state,
            AgentState::Starting
        );
        let error = source.get_messages(&sessions[0]).unwrap_err();
        assert_eq!(error.code, "agent_messages_unavailable");
    }

    #[test]
    fn terminal_identity_does_not_require_provider_metadata() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.agent_id = None;
        registry.observe_terminal_started(&terminal, "now");

        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].provider, "terminal-agent");

        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: String::new(),
                event_id: Some("event-without-provider".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            None,
            "now",
        ));
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry
            .status(&session)
            .unwrap()
            .warnings
            .iter()
            .any(|warning| warning == "completion observed, result unavailable"));
        assert!(registry.last_result(&session).unwrap().is_none());
    }

    #[test]
    fn observed_completion_provider_overrides_configured_hint_and_records_mismatch() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.agent_id = Some("pi".to_string());
        registry.observe_terminal_started(&terminal, "before");
        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("codex-event".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            None,
            "after",
        ));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(session.configured_agent_id.as_deref(), Some("pi"));
        assert_eq!(session.observed_provider.as_deref(), Some("codex"));
        assert_eq!(session.resolved_provider, "codex");
        assert_eq!(session.detection_source, "completion-event");
        assert!(session
            .identity_warnings
            .iter()
            .any(|warning| warning.contains("configured agent 'pi'")));
        registry.observe_terminal_started(&terminal, "later");
        let session_after_refresh = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(session_after_refresh.resolved_provider, "codex");
    }

    #[test]
    fn generic_terminal_is_promoted_by_runtime_observation() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.is_agent_terminal = false;
        terminal.agent_id = None;
        terminal.observed_provider = Some("freebuff".to_string());
        terminal.detection_source = "command-observed".to_string();
        terminal.detection_confidence = 0.8;
        let reference = registry
            .observe_terminal_started(&terminal, "now")
            .expect("runtime detection promotes a generic terminal");
        assert_eq!(reference.resolved_provider, "freebuff");
        assert_eq!(reference.detection_source, "command-observed");
    }

    #[test]
    fn providers_and_results_stay_isolated_by_terminal_and_generation() {
        let registry = AgentSessionRegistry::default();
        let mut codex = terminal(1, true);
        codex.terminal_id = "codex-terminal".to_string();
        let mut pi = terminal(1, true);
        pi.terminal_id = "pi-terminal".to_string();
        pi.agent_id = Some("pi".to_string());
        registry.observe_terminal_started(&codex, "now");
        registry.observe_terminal_started(&pi, "now");
        assert!(registry.observe_completion(
            &codex,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("codex-1".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            Some(super::super::types::AgentResult {
                content: "codex result".to_string(),
                truncated: false,
                untrusted: true,
                provenance: Provenance::untrusted("test", "now"),
            }),
            "now",
        ));
        assert!(registry.observe_completion(
            &pi,
            CompletionObservation {
                provider: "pi".to_string(),
                event_id: Some("pi-1".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            Some(super::super::types::AgentResult {
                content: "pi result".to_string(),
                truncated: false,
                untrusted: true,
                provenance: Provenance::untrusted("test", "now"),
            }),
            "now",
        ));
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 2);
        for session in sessions {
            let result = registry.last_result(&session).unwrap().unwrap();
            if session.terminal_id.as_deref() == Some("codex-terminal") {
                assert_eq!(result.content, "codex result");
            } else {
                assert_eq!(result.content, "pi result");
            }
        }
    }

    #[test]
    fn pruning_is_bounded_and_keeps_the_current_generation() {
        let registry = AgentSessionRegistry::default();
        for generation in 1..=300 {
            started(&registry, generation);
        }
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert!(sessions.len() <= super::MAX_RETAINED_SESSIONS);
        assert!(sessions.len() <= super::MAX_TERMINAL_HISTORY + 1);
        assert!(sessions.iter().any(|session| session.generation == 300));
    }

    #[test]
    fn completion_dedupe_eviction_accepts_a_new_event_after_the_bound() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        let observation = |event_id: String| CompletionObservation {
            provider: "codex".to_string(),
            event_id: Some(event_id),
            provider_session_id: None,
            provider_turn_id: None,
            occurred_at: None,
        };
        assert!(registry.observe_completion(
            &terminal,
            observation("original".to_string()),
            None,
            "now",
        ));
        for index in 0..super::MAX_COMPLETION_KEYS {
            assert!(registry.observe_completion(
                &terminal,
                observation(format!("event-{index}")),
                None,
                "now",
            ));
        }
        assert!(registry.observe_completion(
            &terminal,
            observation("original".to_string()),
            None,
            "later",
        ));
    }

    #[test]
    fn reconciliation_is_idempotent_and_marks_missing_terminals_exited() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.reconcile(std::slice::from_ref(&terminal), "first");
        registry.reconcile(std::slice::from_ref(&terminal), "second");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(registry.list_sessions("workspace-a").unwrap().len(), 1);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Starting
        );

        registry.reconcile(&[], "third");
        assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
    }

    // ---- Phase 7: agent session intelligence -----------------------------

    #[test]
    fn observed_agent_process_without_a_task_is_waiting_not_working() {
        let registry = AgentSessionRegistry::default();
        let mut observed = terminal(1, true);
        observed.observed_provider = Some("codex".to_string());
        observed.detection_source = "process-tree".to_string();
        observed.detection_confidence = 0.95;
        registry.observe_terminal_started(&observed, "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Waiting
        );
    }

    fn task_of(status: &super::AgentRegistryStatus) -> &AgentTaskContext {
        status
            .current_task
            .as_ref()
            .expect("expected a current task")
    }

    fn commit(
        registry: &AgentSessionRegistry,
        terminal: &TerminalAgentSnapshot,
        text: &str,
        at: &str,
    ) {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(b'\r');
        registry.observe_user_input(terminal, &bytes, at);
    }

    #[test]
    fn user_committed_input_becomes_a_user_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(&registry, &terminal, "fix the bug", "2026-08-07T00:00:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        let task = task_of(&status);
        assert_eq!(task.text, "fix the bug");
        assert_eq!(task.source, AgentInteractionSource::User);
        assert_eq!(task.confidence, 0.65);
        assert!(task.untrusted);
        assert!(task.completed_at.is_none());
        assert_eq!(status.state, AgentState::Working);
        assert!(status.activity_timeline.iter().any(|event| {
            event.kind == AgentActivityKind::PromptSubmitted
                && event.source == AgentInteractionSource::User
                && event.text_excerpt.as_deref() == Some("fix the bug")
        }));
        assert_eq!(
            session.current_task.as_ref().map(|task| task.text.as_str()),
            Some("fix the bug")
        );
    }

    #[test]
    fn jarvis_send_registers_a_trusted_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        started(&registry, 1);
        registry.observe_jarvis_send(&terminal, "refactor the module\n", "2026-08-07T00:00:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        let task = task_of(&status);
        assert_eq!(task.source, AgentInteractionSource::Jarvis);
        assert_eq!(task.confidence, 0.95);
        assert!(!task.untrusted);
        assert_eq!(task.text, "refactor the module\n");
        assert!(status
            .activity_timeline
            .iter()
            .any(|event| event.source == AgentInteractionSource::Jarvis && !event.untrusted));
    }

    #[test]
    fn without_successful_write_or_commit_no_task_is_registered() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        started(&registry, 1);

        registry.observe_user_input(&terminal, b"draft", "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry.status(&session).unwrap().current_task.is_none());

        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry.status(&session).unwrap().current_task.is_none());
    }

    #[test]
    fn backspace_reconstructs_the_committed_line() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.observe_user_input(&terminal, b"fixx\x08 the bug\r", "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            task_of(&registry.status(&session).unwrap()).text,
            "fix the bug"
        );
    }

    #[test]
    fn bracketed_paste_commits_multiline_input() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.observe_user_input(
            &terminal,
            b"\x1b[200~first\nsecond\x1b[201~\r",
            "2026-08-07T00:00:00Z",
        );
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            task_of(&registry.status(&session).unwrap()).text,
            "first\nsecond"
        );
    }

    #[test]
    fn unsupported_cursor_edit_invalidates_the_whole_line_until_enter() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.observe_user_input(&terminal, b"prefix\x1b[Dsuffix\r", "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry.status(&session).unwrap().current_task.is_none());

        commit(
            &registry,
            &terminal,
            "clean next task",
            "2026-08-07T00:01:00Z",
        );
        assert_eq!(
            task_of(&registry.status(&session).unwrap()).text,
            "clean next task"
        );
    }

    #[test]
    fn oversized_input_never_commits_a_truncated_suffix() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        let mut bytes = vec![b'x'; MAX_INPUT_BUFFER_BYTES + 64];
        bytes.extend_from_slice(b"suffix\r");
        registry.observe_user_input(&terminal, &bytes, "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry.status(&session).unwrap().current_task.is_none());

        commit(
            &registry,
            &terminal,
            "clean after overflow",
            "2026-08-07T00:01:00Z",
        );
        assert_eq!(
            task_of(&registry.status(&session).unwrap()).text,
            "clean after overflow"
        );
    }

    #[test]
    fn ctrl_c_interrupts_without_inventing_a_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.observe_user_input(&terminal, b"half a line\x03", "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        assert!(status.current_task.is_none());
        assert!(status
            .activity_timeline
            .iter()
            .any(|event| event.kind == AgentActivityKind::Interrupted));

        commit(&registry, &terminal, "next task", "2026-08-07T00:01:00Z");
        assert_eq!(
            task_of(&registry.status(&session).unwrap()).text,
            "next task"
        );
    }

    #[test]
    fn model_and_help_are_activity_but_never_replace_the_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(
            &registry,
            &terminal,
            "refactor the core",
            "2026-08-07T00:00:00Z",
        );
        commit(&registry, &terminal, "/model", "2026-08-07T00:01:00Z");
        commit(&registry, &terminal, "/help", "2026-08-07T00:02:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        assert_eq!(task_of(&status).text, "refactor the core");
        let prompts = status
            .activity_timeline
            .iter()
            .filter(|event| event.kind == AgentActivityKind::PromptSubmitted)
            .count();
        assert_eq!(prompts, 3);
    }

    #[test]
    fn clear_and_new_archive_the_previous_agent_epoch_in_the_same_pty() {
        for reset_command in ["/clear", "/new"] {
            let registry = AgentSessionRegistry::default();
            let terminal = terminal(1, true);
            commit(
                &registry,
                &terminal,
                "task before reset",
                "2026-08-07T00:00:00Z",
            );
            let previous = registry.list_sessions("workspace-a").unwrap().remove(0);

            commit(&registry, &terminal, reset_command, "2026-08-07T00:01:00Z");

            let sessions = registry.list_sessions("workspace-a").unwrap();
            assert_eq!(sessions.len(), 2, "{reset_command}");
            let archived = sessions
                .iter()
                .find(|session| session.agent_session_id == previous.agent_session_id)
                .expect("previous epoch retained");
            assert_eq!(
                registry.status(archived).unwrap().state,
                AgentState::Exited,
                "{reset_command}",
            );
            let current = sessions
                .iter()
                .find(|session| session.agent_session_id != previous.agent_session_id)
                .expect("new epoch created");
            let status = registry.status(current).unwrap();
            assert!(status.current_task.is_none(), "{reset_command}");
            assert_ne!(current.agent_session_id, previous.agent_session_id);
        }
    }

    #[test]
    fn pasted_task_after_session_reset_is_attributed_to_the_new_epoch() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(
            &registry,
            &terminal,
            "task before reset",
            "2026-08-07T00:00:00Z",
        );

        registry.observe_user_input(
            &terminal,
            b"/clear\rnew task after reset\r",
            "2026-08-07T00:01:00Z",
        );

        let current = registry
            .list_sessions("workspace-a")
            .unwrap()
            .into_iter()
            .find(|session| {
                registry
                    .status(session)
                    .is_ok_and(|status| status.state != AgentState::Exited)
            })
            .expect("current epoch");
        assert_eq!(
            registry
                .status(&current)
                .unwrap()
                .current_task
                .expect("task")
                .text,
            "new task after reset"
        );
    }

    #[test]
    fn local_command_after_completion_preserves_waiting_state() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(&registry, &terminal, "real task", "2026-08-07T00:00:00Z");
        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("local-command-state".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            None,
            "2026-08-07T00:01:00Z",
        ));
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Waiting
        );

        commit(&registry, &terminal, "/model", "2026-08-07T00:02:00Z");
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Waiting);
        assert_eq!(task_of(&status).text, "real task");
        assert_eq!(
            task_of(&status).completed_at.as_deref(),
            Some("2026-08-07T00:01:00Z")
        );
    }

    #[test]
    fn agent_launch_command_is_session_startup_not_a_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(&registry, &terminal, "codex", "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(registry.status(&session).unwrap().current_task.is_none());
    }

    #[test]
    fn output_never_becomes_a_task_and_is_throttled() {
        let registry = AgentSessionRegistry::default();
        started(&registry, 1);
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);

        registry.observe_output("terminal-1", 1, "2026-08-07T00:00:00Z");
        assert_eq!(
            registry
                .status(&session)
                .unwrap()
                .last_activity_at
                .as_deref(),
            Some("2026-08-07T00:00:00Z")
        );
        assert!(registry.status(&session).unwrap().current_task.is_none());

        registry.observe_output("terminal-1", 1, "2026-08-07T00:00:00.500Z");
        assert_eq!(
            registry
                .status(&session)
                .unwrap()
                .last_activity_at
                .as_deref(),
            Some("2026-08-07T00:00:00Z")
        );
        registry.observe_output("terminal-1", 1, "2026-08-07T00:00:01.100Z");
        assert_eq!(
            registry
                .status(&session)
                .unwrap()
                .last_activity_at
                .as_deref(),
            Some("2026-08-07T00:00:01.100Z")
        );
    }

    #[test]
    fn task_text_and_timeline_are_bounded() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        let long_text = format!("\u{1f600} {}", "x".repeat(3000));
        commit(&registry, &terminal, &long_text, "2026-08-07T00:00:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        let task = task_of(&status);
        assert!(task.text.len() <= MAX_TASK_TEXT_BYTES);

        for index in 0..40 {
            registry.observe_jarvis_send(
                &terminal,
                &format!("prompt {index}"),
                &format!("2026-08-07T00:{:02}:00Z", index),
            );
        }
        let timeline = &registry.status(&session).unwrap().activity_timeline;
        assert!(timeline.len() <= MAX_ACTIVITY_TIMELINE);
    }

    #[test]
    fn generation_and_workspace_isolate_tasks_and_activity() {
        let registry = AgentSessionRegistry::default();
        let first = terminal(1, true);
        commit(
            &registry,
            &first,
            "task in generation 1",
            "2026-08-07T00:00:00Z",
        );

        let mut other = terminal(1, true);
        other.terminal_id = "terminal-2".to_string();
        other.workspace_id = "workspace-b".to_string();
        commit(
            &registry,
            &other,
            "task in workspace b",
            "2026-08-07T00:00:10Z",
        );

        let second_generation = terminal(2, true);
        commit(
            &registry,
            &second_generation,
            "task in generation 2",
            "2026-08-07T00:00:20Z",
        );

        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 2);
        let first_status = registry.status(&sessions[0]).unwrap();
        let second_status = registry.status(&sessions[1]).unwrap();
        assert_eq!(task_of(&first_status).text, "task in generation 1");
        assert_eq!(task_of(&second_status).text, "task in generation 2");
        assert_eq!(first_status.state, AgentState::Exited);

        let mut forged = sessions[0].clone();
        forged.workspace_id = "workspace-b".to_string();
        assert!(registry.activity(&forged, DEFAULT_ACTIVITY_LIMIT).is_err());

        let workspace_b = registry.list_sessions("workspace-b").unwrap();
        assert_eq!(workspace_b.len(), 1);
        assert_eq!(
            task_of(&registry.status(&workspace_b[0]).unwrap()).text,
            "task in workspace b"
        );
    }

    #[test]
    fn activity_lookup_is_bounded() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        for index in 0..20 {
            registry.observe_jarvis_send(
                &terminal,
                &format!("prompt {index}"),
                &format!("2026-08-07T00:{:02}:00Z", index),
            );
        }
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            registry.activity(&session, 100).unwrap().len(),
            MAX_ACTIVITY_LIMIT
        );
        assert_eq!(registry.activity(&session, 0).unwrap().len(), 1);
        assert_eq!(registry.activity(&session, 2).unwrap().len(), 2);
    }

    #[test]
    fn completion_marks_the_task_completed_but_keeps_the_session_open() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(&registry, &terminal, "fix the bug", "2026-08-07T00:00:00Z");
        assert!(registry.observe_completion(
            &terminal,
            CompletionObservation {
                provider: "codex".to_string(),
                event_id: Some("event-done".to_string()),
                provider_session_id: None,
                provider_turn_id: None,
                occurred_at: None,
            },
            Some(AgentResult {
                content: "done".to_string(),
                truncated: false,
                untrusted: true,
                provenance: Provenance::untrusted("terminal-fallback", "now"),
            }),
            "2026-08-07T00:01:00Z",
        ));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Waiting);
        assert_eq!(
            task_of(&status).completed_at.as_deref(),
            Some("2026-08-07T00:01:00Z")
        );
        assert!(status
            .activity_timeline
            .iter()
            .any(|event| event.kind == AgentActivityKind::CompletionObserved));
        assert!(status
            .activity_timeline
            .iter()
            .any(|event| event.kind == AgentActivityKind::ResultAvailable));
        assert_eq!(
            registry.last_result(&session).unwrap().unwrap().content,
            "done"
        );

        commit(&registry, &terminal, "second task", "2026-08-07T00:02:00Z");
        assert!(registry
            .status(&session)
            .unwrap()
            .current_task
            .as_ref()
            .unwrap()
            .completed_at
            .is_none());
    }

    #[test]
    fn abort_records_jarvis_interruption_without_completing_the_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(
            &registry,
            &terminal,
            "long running task",
            "2026-08-07T00:00:00Z",
        );
        registry.observe_abort(&terminal, "2026-08-07T00:01:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        let task = task_of(&status);
        assert!(task.completed_at.is_none());
        assert!(status.activity_timeline.iter().any(|event| {
            event.kind == AgentActivityKind::Interrupted
                && event.source == AgentInteractionSource::Jarvis
                && !event.untrusted
        }));
        assert_eq!(
            status.last_activity_at.as_deref(),
            Some("2026-08-07T00:01:00Z")
        );
    }

    #[test]
    fn session_exit_adds_an_exited_activity_without_touching_the_task() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        commit(&registry, &terminal, "final task", "2026-08-07T00:00:00Z");
        registry.observe_terminal_exit("terminal-1", 1, "2026-08-07T00:01:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Exited);
        assert!(status
            .activity_timeline
            .iter()
            .any(|event| event.kind == AgentActivityKind::Exited));
        assert!(task_of(&status).completed_at.is_none());
    }

    #[test]
    fn session_exit_clears_stale_identity_confirmation() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.observed_provider = Some("pi".to_string());
        terminal.agent_id = Some("pi".to_string());
        terminal.detection_source = "command-observed".to_string();
        terminal.detection_confidence = 0.7;
        registry.observe_terminal_started(&terminal, "2026-08-12T00:00:00Z");
        assert!(
            registry
                .list_sessions("workspace-a")
                .unwrap()
                .remove(0)
                .identity_needs_confirmation
        );

        registry.observe_terminal_exit("terminal-1", 1, "2026-08-12T00:01:00Z");
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(registry.status(&session).unwrap().state, AgentState::Exited);
        assert!(!session.identity_needs_confirmation);
    }

    #[test]
    fn reset_and_reconcile_exit_paths_clear_identity_confirmation() {
        let registry = AgentSessionRegistry::default();
        let mut terminal = terminal(1, true);
        terminal.agent_id = Some("pi".to_string());
        terminal.observed_provider = Some("pi".to_string());
        terminal.detection_source = "command-observed".to_string();
        terminal.detection_confidence = 0.7;
        registry.observe_terminal_started(&terminal, "2026-08-12T00:00:00Z");
        registry.observe_user_input(&terminal, b"/clear\r", "2026-08-12T00:00:01Z");
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert!(sessions.iter().all(|session| {
            !session.identity_needs_confirmation
                || registry.status(session).unwrap().state != AgentState::Exited
        }));

        let mut missing_terminal = terminal.clone();
        missing_terminal.is_agent_terminal = false;
        missing_terminal.observed_provider = None;
        registry.reconcile(&[missing_terminal], "2026-08-12T00:00:02Z");
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert!(sessions.iter().all(|session| {
            registry.status(session).unwrap().state != AgentState::Exited
                || !session.identity_needs_confirmation
        }));
    }

    #[test]
    fn relaunch_after_agent_child_exit_creates_a_new_epoch_without_reopening_the_pty() {
        let registry = AgentSessionRegistry::default();
        let terminal = terminal(1, true);
        registry.observe_terminal_started(&terminal, "2026-08-07T00:00:00Z");
        let first = registry.list_sessions("workspace-a").unwrap().remove(0);
        registry.observe_terminal_exit("terminal-1", 1, "2026-08-07T00:01:00Z");

        registry.observe_terminal_started(&terminal, "2026-08-07T00:02:00Z");
        let sessions = registry.list_sessions("workspace-a").unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions
            .iter()
            .any(|session| session.agent_session_id == first.agent_session_id));
        assert!(sessions
            .iter()
            .any(|session| session.agent_session_id != first.agent_session_id));
    }

    // -- idle completion detector --

    #[test]
    fn output_silence_never_claims_that_a_working_turn_completed() {
        let registry = AgentSessionRegistry::default();
        registry.observe_jarvis_send(
            &terminal(1, true),
            "refactor the module
",
            "2026-08-11T00:00:00Z",
        );
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Working
        );

        // Reasoning can be silent for much longer than ten seconds. Only a
        // provider completion notification may settle the turn.
        let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:11Z");
        assert!(settled.is_empty());
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        let status = registry.status(&session).unwrap();
        assert_eq!(status.state, AgentState::Working);
        assert!(!status
            .activity_timeline
            .iter()
            .any(|event| event.kind == AgentActivityKind::CompletionObserved));
    }

    #[test]
    fn active_working_session_is_not_settled_while_output_continues() {
        let registry = AgentSessionRegistry::default();
        registry.observe_jarvis_send(
            &terminal(1, true),
            "start task
",
            "2026-08-11T00:00:00Z",
        );
        registry.observe_output("terminal-1", 1, "2026-08-11T00:00:09Z");
        let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:15Z");
        assert!(settled.is_empty());
        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert_eq!(
            registry.status(&session).unwrap().state,
            AgentState::Working
        );
    }

    #[test]
    fn session_without_observed_output_is_left_untouched() {
        let registry = AgentSessionRegistry::default();
        let mut agent = terminal(1, true);
        agent.agent_id = Some("pi".to_string());
        agent.observed_provider = Some("pi".to_string());
        agent.detection_source = "command-observed".to_string();
        agent.detection_confidence = 0.7;
        registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
        // No output ever observed (last_activity_at is None): not settled.
        let settled = registry.mark_idle_sessions_completed("2026-08-11T00:00:30Z");
        assert!(settled.is_empty());
    }

    // -- identity confirmation (human action confirms manual agent) --

    #[test]
    fn confirm_identity_unblocks_manual_agent_detected_from_command() {
        let registry = AgentSessionRegistry::default();
        // Manual agent (pi) detected from its launch command: observed
        // provider, command-observed source, confidence 0.7 < 0.75 gate.
        let mut agent = terminal(1, true);
        agent.agent_id = Some("pi".to_string());
        agent.observed_provider = Some("pi".to_string());
        agent.detection_source = "command-observed".to_string();
        agent.detection_confidence = 0.7;
        registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(session.identity_needs_confirmation);
        assert!(!registry.control_allowed("terminal-1", 1));

        // The human confirmation of the action doubles as the identity
        // confirmation: control is granted without any extra UI step.
        assert!(registry.confirm_identity_for_terminal("terminal-1", 1));
        assert!(registry.control_allowed("terminal-1", 1));

        let session = registry.list_sessions("workspace-a").unwrap().remove(0);
        assert!(!session.identity_needs_confirmation);
    }

    #[test]
    fn confirm_identity_is_a_noop_for_already_confirmed_or_ignored_agents() {
        let registry = AgentSessionRegistry::default();
        // Codex runtime: process-tree detection, above the gate.
        let agent = terminal(1, true);
        registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
        assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));

        // Ignored decision is never overridden by the action path.
        let mut manual = terminal(1, true);
        manual.agent_id = Some("pi".to_string());
        manual.observed_provider = Some("pi".to_string());
        manual.detection_source = "command-observed".to_string();
        manual.detection_confidence = 0.7;
        registry.observe_terminal_started(&manual, "2026-08-11T00:00:01Z");
        registry.set_identity_decision("terminal-1", 1, "pi", IdentityDecision::Ignored);
        assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));
        assert!(!registry.control_allowed("terminal-1", 1));
    }

    #[test]
    fn confirm_identity_does_not_unblock_exited_sessions() {
        let registry = AgentSessionRegistry::default();
        let mut agent = terminal(1, false);
        agent.agent_id = Some("pi".to_string());
        agent.observed_provider = Some("pi".to_string());
        agent.detection_source = "command-observed".to_string();
        agent.detection_confidence = 0.7;
        registry.observe_terminal_started(&agent, "2026-08-11T00:00:00Z");
        assert!(!registry.confirm_identity_for_terminal("terminal-1", 1));
        assert!(!registry.control_allowed("terminal-1", 1));
    }
}
