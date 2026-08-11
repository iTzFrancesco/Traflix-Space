use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::jarvis::agent_registry::{
    fallback_result_from_terminal_with_truncation, CompletionObservation,
    MAX_TERMINAL_FALLBACK_BYTES,
};
use crate::jarvis::JarvisState;
use crate::terminal_engine::TerminalManager;

pub const AGENT_EVENT_PROTOCOL: u8 = 1;

/// Named pipe for agent turn events. Dev (debug) builds use a separate pipe
/// name so a dev server can receive notifications even while the installed
/// (release) app is running in the tray and owns the release pipe.
pub fn agent_event_pipe_name() -> &'static str {
    if cfg!(debug_assertions) {
        r"\\.\pipe\traflix-space-agent-events-dev"
    } else {
        r"\\.\pipe\traflix-space-agent-events"
    }
}
const MAX_EVENT_BYTES: usize = 32 * 1024;
const MAX_DEDUPE_ENTRIES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnCompletedEvent {
    pub protocol: u8,
    pub provider: String,
    pub kind: String,
    pub terminal_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
    #[serde(default)]
    pub process_id: Option<u32>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub occurred_at: Option<String>,
}

#[derive(Default)]
struct SeenEvents {
    set: HashSet<String>,
    order: VecDeque<String>,
}

#[derive(Clone, Default)]
pub struct AgentEventRegistry {
    seen: Arc<Mutex<SeenEvents>>,
}

impl AgentEventRegistry {
    fn accept_once(&self, key: String) -> bool {
        let Ok(mut seen) = self.seen.lock() else {
            return false;
        };

        if seen.set.contains(&key) {
            return false;
        }

        seen.set.insert(key.clone());
        seen.order.push_back(key);
        while seen.order.len() > MAX_DEDUPE_ENTRIES {
            if let Some(oldest) = seen.order.pop_front() {
                seen.set.remove(&oldest);
            }
        }
        true
    }
}

impl AgentTurnCompletedEvent {
    fn dedupe_key(&self) -> Option<String> {
        if let Some(event_id) = self.event_id.as_deref().filter(|value| !value.is_empty()) {
            return Some(format!(
                "event:{}:{}:{}:{}",
                self.terminal_id,
                self.generation.unwrap_or_default(),
                self.provider,
                event_id
            ));
        }

        let session = self.provider_session_id.as_deref().unwrap_or_default();
        let turn = self.provider_turn_id.as_deref().unwrap_or_default();
        if session.is_empty() && turn.is_empty() {
            return None;
        }

        Some(format!(
            "{}:{}:{}:{}:{}:{}",
            self.terminal_id,
            self.generation.unwrap_or_default(),
            self.provider,
            self.kind,
            session,
            turn
        ))
    }
}

fn matches_terminal_generation(event_generation: Option<u64>, current_generation: u64) -> bool {
    // Some Codex adapters do not include the local PTY generation. The
    // caller has already proven that the terminal id is live and then checks
    // process/workspace identity when those fields are present. Reject only
    // an explicitly different generation here.
    event_generation.is_none_or(|generation| generation == current_generation)
}

pub fn start_listener(app: AppHandle) {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_named_pipe_server(app).await {
                warn!(%error, "Agent event named pipe stopped");
            }
        });
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        info!("Agent event listener is disabled outside Windows");
    }
}

#[cfg(windows)]
async fn run_named_pipe_server(app: AppHandle) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::windows::named_pipe::ServerOptions;

    // Try to own the pipe as the first instance. If another Traflix instance
    // already owns it, fall back to a co-listener so the server can still
    // receive events instead of silently dying. A dev build uses its own pipe
    // name, so it never conflicts with the installed app.
    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .create(agent_event_pipe_name())
    {
        Ok(s) => {
            info!(
                pipe = agent_event_pipe_name(),
                "Agent event named pipe ready (owner)"
            );
            s
        }
        Err(e) if pipe_busy(&e) => {
            warn!(
                pipe = agent_event_pipe_name(),
                "Agent event pipe already owned by another Traflix instance; running as co-listener"
            );
            ServerOptions::new().create(agent_event_pipe_name())?
        }
        Err(e) => return Err(e),
    };

    loop {
        server.connect().await?;
        let connected = server;

        // Create the next instance before processing this short-lived client.
        // This avoids a connection race when several agents finish together.
        server = ServerOptions::new().create(agent_event_pipe_name())?;

        let client_app = app.clone();
        let registry = client_app.state::<AgentEventRegistry>().inner().clone();
        tauri::async_runtime::spawn(async move {
            let mut line = String::new();
            let mut reader = BufReader::new(connected);
            match reader.read_line(&mut line).await {
                Ok(bytes) if bytes > 0 && bytes <= MAX_EVENT_BYTES => {
                    info!(bytes, "Agent event received from named pipe");
                    handle_payload(&client_app, &registry, line.trim()).await;
                }
                Ok(bytes) if bytes > MAX_EVENT_BYTES => {
                    warn!(bytes, "Agent event payload rejected: too large");
                }
                Ok(_) => {}
                Err(error) => warn!(%error, "Agent event pipe read failed"),
            }
        });
    }
}

#[cfg(windows)]
fn pipe_busy(error: &std::io::Error) -> bool {
    // ERROR_PIPE_BUSY = 231 (another instance owns the first pipe instance).
    error.raw_os_error() == Some(231)
}

async fn handle_payload(app: &AppHandle, registry: &AgentEventRegistry, payload: &str) {
    let mut event = match serde_json::from_str::<AgentTurnCompletedEvent>(payload) {
        Ok(event) => event,
        Err(error) => {
            warn!(%error, "Agent event payload rejected: invalid JSON");
            return;
        }
    };

    info!(
        provider = %event.provider,
        kind = %event.kind,
        terminal_id = %event.terminal_id,
        event_id = event.event_id.as_deref().unwrap_or("-"),
        "Agent notification parsed"
    );

    if event.protocol != AGENT_EVENT_PROTOCOL
        || event.kind != "turn_completed"
        || event.provider.trim().is_empty()
        || event.provider.len() > 32
        || event.terminal_id.trim().is_empty()
        || event.terminal_id.len() > 256
    {
        warn!("Agent event payload rejected: invalid contract");
        return;
    }

    let manager = app.state::<TerminalManager>();
    let terminal_known = manager.has_session(&event.terminal_id);
    if !terminal_known {
        // A completion without a current PTY identity cannot be distinguished
        // from a late event emitted after close/reopen. Forwarding it would
        // produce a chime/toast that can no longer open the originating pane.
        warn!(terminal_id = %event.terminal_id, "Agent completion ignored for unknown or closed terminal");
        return;
    }

    let local_snapshot = if terminal_known {
        match manager.get_agent_snapshot(&event.terminal_id).await {
            Ok(Some(snapshot)) => {
                if !matches_terminal_generation(event.generation, snapshot.generation) {
                    warn!(
                        terminal_id = %event.terminal_id,
                        event_generation = ?event.generation,
                        current_generation = snapshot.generation,
                        "Agent completion ignored: missing or stale terminal generation"
                    );
                    return;
                }
                if let Some(event_process_id) = event.process_id {
                    if snapshot.process_id != Some(event_process_id) {
                        warn!(
                            terminal_id = %event.terminal_id,
                            event_process_id,
                            current_process_id = ?snapshot.process_id,
                            "Agent completion ignored for stale terminal process"
                        );
                        return;
                    }
                }
                if let Some(event_workspace_id) = event
                    .workspace_id
                    .as_deref()
                    .filter(|workspace_id| !workspace_id.is_empty())
                {
                    if event_workspace_id != snapshot.workspace_id {
                        warn!(
                            terminal_id = %event.terminal_id,
                            event_workspace_id,
                            current_workspace_id = %snapshot.workspace_id,
                            "Agent completion ignored for mismatched workspace"
                        );
                        return;
                    }
                }
                // The terminal manager is authoritative for locally-owned events.
                // Adapters know the generation from the PTY environment; process and
                // workspace are normalized here before the frontend sees the event.
                event.generation = Some(snapshot.generation);
                event.process_id = snapshot.process_id;
                event.workspace_id = Some(snapshot.workspace_id.clone());
                Some(snapshot)
            }
            _ => {
                warn!(
                    terminal_id = %event.terminal_id,
                    "Agent completion could not be correlated with a terminal agent session"
                );
                return;
            }
        }
    } else {
        None
    };

    // Deduplicate only after local identity validation. An invalid stale event
    // must not reserve the event key and suppress the legitimate current event.
    if let Some(key) = event.dedupe_key() {
        if !registry.accept_once(key) {
            info!(
                provider = %event.provider,
                terminal_id = %event.terminal_id,
                event_id = event.event_id.as_deref().unwrap_or("-"),
                "Agent notification ignored as duplicate"
            );
            return;
        }
    }

    if let Some(snapshot) = local_snapshot {
        if manager
            .observe_agent_provider_for_runtime(
                &event.terminal_id,
                &snapshot.workspace_id,
                snapshot.generation,
                snapshot.process_id,
                &event.provider,
                "completion-event",
                1.0,
            )
            .await
            .is_err()
        {
            warn!(terminal_id = %event.terminal_id, "Agent completion ignored because its PTY lifetime was replaced");
            return;
        }
        let observed_at = event
            .occurred_at
            .clone()
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let fallback = manager
            .get_recent_normalized_terminal_text_for_runtime(
                &event.terminal_id,
                &snapshot.workspace_id,
                snapshot.generation,
                snapshot.process_id,
                MAX_TERMINAL_FALLBACK_BYTES,
            )
            .await
            .ok()
            .and_then(|text| {
                fallback_result_from_terminal_with_truncation(
                    &text.content,
                    text.truncated,
                    &observed_at,
                )
            });
        if manager
            .validate_runtime_identity(
                &event.terminal_id,
                &snapshot.workspace_id,
                snapshot.generation,
                snapshot.process_id,
            )
            .await
            .is_err()
        {
            warn!(terminal_id = %event.terminal_id, "Agent completion ignored after runtime changed during tail capture");
            return;
        }
        let observation = CompletionObservation {
            provider: event.provider.clone(),
            event_id: event.event_id.clone(),
            provider_session_id: event.provider_session_id.clone(),
            provider_turn_id: event.provider_turn_id.clone(),
            occurred_at: event.occurred_at.clone(),
        };
        if let Some(jarvis) = app.try_state::<JarvisState>() {
            jarvis
                .registry
                .observe_completion(&snapshot, observation, fallback, &observed_at);
        }
    }

    info!(
        terminal_id = %event.terminal_id,
        provider = %event.provider,
        event_id = event.event_id.as_deref().unwrap_or("-"),
        "Agent notification accepted"
    );
    let Some(workspace_id) = event.workspace_id.as_deref() else {
        return;
    };
    let Some(generation) = event.generation else {
        return;
    };
    if manager
        .validate_runtime_identity(
            &event.terminal_id,
            workspace_id,
            generation,
            event.process_id,
        )
        .await
        .is_err()
    {
        warn!(terminal_id = %event.terminal_id, "Agent completion ignored before emit because runtime changed");
        return;
    }
    match app.emit("agent-turn-completed", event) {
        Ok(()) => info!("Agent notification forwarded to frontend"),
        Err(error) => warn!(%error, "Agent notification could not reach frontend"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> AgentTurnCompletedEvent {
        AgentTurnCompletedEvent {
            protocol: AGENT_EVENT_PROTOCOL,
            provider: "codex".to_string(),
            kind: "turn_completed".to_string(),
            terminal_id: "terminal-1".to_string(),
            generation: Some(1),
            process_id: Some(100),
            event_id: Some("event-1".to_string()),
            workspace_id: None,
            provider_session_id: Some("session-1".to_string()),
            provider_turn_id: Some("turn-1".to_string()),
            cwd: None,
            occurred_at: None,
        }
    }

    #[test]
    fn dedupe_key_prefers_explicit_event_id() {
        assert_eq!(
            event().dedupe_key().as_deref(),
            Some("event:terminal-1:1:codex:event-1")
        );
    }

    #[test]
    fn registry_accepts_an_event_only_once() {
        let registry = AgentEventRegistry::default();
        let key = event().dedupe_key().unwrap();
        assert!(registry.accept_once(key.clone()));
        assert!(!registry.accept_once(key));
    }

    #[test]
    fn registry_eviction_is_bounded_and_allows_a_legitimate_later_duplicate() {
        let registry = AgentEventRegistry::default();
        let original = event().dedupe_key().unwrap();
        assert!(registry.accept_once(original.clone()));
        for index in 0..MAX_DEDUPE_ENTRIES {
            assert!(registry.accept_once(format!("event-{index}")));
        }
        assert!(registry.accept_once(original));
        let seen = registry.seen.lock().expect("registry lock");
        assert_eq!(seen.set.len(), MAX_DEDUPE_ENTRIES);
        assert_eq!(seen.order.len(), MAX_DEDUPE_ENTRIES);
    }

    #[test]
    fn completion_generation_must_match_the_current_terminal_generation() {
        assert!(matches_terminal_generation(Some(7), 7));
        assert!(!matches_terminal_generation(Some(6), 7));
        // Codex adapters may omit generation. The live terminal/process
        // checks in handle_payload provide the remaining stale-event guard.
        assert!(matches_terminal_generation(None, 7));
    }
}
