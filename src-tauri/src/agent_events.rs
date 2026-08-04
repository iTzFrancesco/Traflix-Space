use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

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
                "event:{}:{}:{}",
                self.terminal_id, self.provider, event_id
            ));
        }

        let session = self.provider_session_id.as_deref().unwrap_or_default();
        let turn = self.provider_turn_id.as_deref().unwrap_or_default();
        if session.is_empty() && turn.is_empty() {
            return None;
        }

        Some(format!(
            "{}:{}:{}:{}:{}",
            self.terminal_id, self.provider, self.kind, session, turn
        ))
    }
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
            info!(pipe = agent_event_pipe_name(), "Agent event named pipe ready (owner)");
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
                    handle_payload(&client_app, &registry, line.trim());
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

fn handle_payload(app: &AppHandle, registry: &AgentEventRegistry, payload: &str) {
    let event = match serde_json::from_str::<AgentTurnCompletedEvent>(payload) {
        Ok(event) => event,
        Err(error) => {
            warn!(%error, "Agent event payload rejected: invalid JSON");
            return;
        }
    };

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

    if let Some(key) = event.dedupe_key() {
        if !registry.accept_once(key) {
            return;
        }
    }

    let manager = app.state::<TerminalManager>();
    let terminal_known = manager.has_session(&event.terminal_id);
    if !terminal_known {
        // The bridge deliberately fans out to DEV and release. The other
        // instance does not own this PTY, but it still needs the event so its
        // Traflix overlay can notify the user above the desktop.
        warn!(terminal_id = %event.terminal_id, "Agent event received for a terminal owned by another Traflix instance");
    }

    info!(
        terminal_id = %event.terminal_id,
        provider = %event.provider,
        "Agent turn completed"
    );
    let _ = app.emit("agent-turn-completed", event);
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
            Some("event:terminal-1:codex:event-1")
        );
    }

    #[test]
    fn registry_accepts_an_event_only_once() {
        let registry = AgentEventRegistry::default();
        let key = event().dedupe_key().unwrap();
        assert!(registry.accept_once(key.clone()));
        assert!(!registry.accept_once(key));
    }
}
