use crate::jarvis::runtime_detector::detect_from_command;
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

mod input_tracker;
use input_tracker::{InputTracker, TrackerSignal};

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

mod activity;
mod identity;
mod lifecycle;

pub(crate) use identity::identity_source_priority;
use identity::{
    identity_from_snapshot, normalize_observed_provider, registry_provenance,
    update_identity_from_snapshot,
};

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

fn push_warning(warnings: &mut Vec<String>, warning: &str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_string());
    }
}

#[cfg(test)]
pub use activity::fallback_result_from_terminal;
pub use activity::fallback_result_from_terminal_with_truncation;

#[cfg(test)]
mod tests;
