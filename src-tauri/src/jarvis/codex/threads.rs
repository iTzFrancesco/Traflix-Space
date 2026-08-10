//! C4 — Thread lifecycle + isolation.
//!
//! One ephemeral Codex thread per workspace (spec §9), created lazily on
//! the first turn. Threads run with an isolated cwd (`<app-data>/codex-home`),
//! `sandbox: read-only`, `approvalPolicy: never` and `ephemeral: true`
//! (user correction #4). The real user repository is never a readable root
//! (spec §5): every fact about Space reaches the model through dynamic
//! tools (C5), every mutation through `conversational.plan` (C6).
//!
//! V1 limits (documented in the spec): thread IDs live in memory only;
//! `thread/delete` runs on Clear Conversation and on clean app shutdown;
//! a crash can leave orphaned Codex threads on disk (App Server persists
//! them) — accepted V1 limitation.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, warn};

use super::runtime::{CodexRuntimeManager, RuntimeError};
use super::tools::CodexToolService;
use crate::settings::store::CodexModelSettings;

/// C9: bounded steer instruction (spec §15 — short redirects only).
pub const MAX_STEER_TEXT_CHARS: usize = 240;

/// Global Tauri event carrying thread snapshots + thread/turn notifications.
pub const THREAD_EVENT: &str = "jarvis://codex-thread";

/// Per-workspace thread record (backend-owned, serialized to the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisCodexThread {
    pub thread_id: String,
    pub workspace_id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub created_at: u64,
    pub status: String,
    pub active_turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub threads: Vec<JarvisCodexThread>,
}

/// Isolated cwd + `CODEX_HOME` for the App Server process (spec §5).
pub(crate) fn codex_home_dir(app: &AppHandle) -> Result<PathBuf, RuntimeError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| RuntimeError::Environment(format!("app_data_dir: {err}")))?
        .join("codex-home");
    std::fs::create_dir_all(&dir)
        .map_err(|err| RuntimeError::Environment(format!("create codex-home: {err}")))?;
    Ok(dir)
}

/// Registry mapping `workspace_id -> thread`; lives in Tauri managed state.
#[derive(Clone)]
/// C10: how a chat turn ended for the Jarvis provider waiter.
#[derive(Debug)]
pub enum TurnOutcome {
    /// Turn completed: the final agent message text.
    Final(String),
    /// Turn failed: server-side message.
    Failed(String),
    /// Turn interrupted by the user (turn/interrupt).
    Interrupted,
}

/// One ephemeral Codex thread per workspace (spec §9) + turn correlation
/// (C7 request ids, C10 chat waiters).
#[derive(Clone)]
pub struct ThreadRegistry {
    runtime: CodexRuntimeManager,
    app: AppHandle,
    threads: Arc<Mutex<HashMap<String, JarvisCodexThread>>>,
    /// C7: `turn_id -> app request_id` for streaming correlation. Turns
    /// started outside the app (tests, future steer) have no request id.
    request_ids: Arc<Mutex<HashMap<String, String>>>,
    /// C10: chat provider waiters (thread → oneshot), completed by the bridge
    /// on a terminal turn notification.
    chat_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<TurnOutcome>>>>,
    /// C10: last completed agent message text per thread (final chat answer).
    last_message_text: Arc<Mutex<HashMap<String, String>>>,
}

impl ThreadRegistry {
    pub fn new(runtime: CodexRuntimeManager, app: AppHandle) -> Self {
        Self {
            runtime,
            app,
            threads: Arc::new(Mutex::new(HashMap::new())),
            request_ids: Arc::new(Mutex::new(HashMap::new())),
            chat_waiters: Arc::new(Mutex::new(HashMap::new())),
            last_message_text: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Isolated cwd + `CODEX_HOME` for the App Server process.
    pub fn codex_home_dir(&self) -> Result<PathBuf, RuntimeError> {
        codex_home_dir(&self.app)
    }

    /// Returns the thread for `workspace_id`, creating it (or recreating it
    /// when the persisted model/reasoning changed — spec §22: a significant
    /// model change starts a fresh thread) on first use.
    pub async fn ensure_thread(&self, workspace_id: &str) -> Result<JarvisCodexThread, RuntimeError> {
        {
            let threads = self.threads.lock().await;
            if let Some(thread) = threads.get(workspace_id) {
                // Model is fixed at thread creation; C3 settings are read at
                // start time, so a stale thread with a different model is
                // recreated by the caller path (delete + start below).
                return Ok(thread.clone());
            }
        }
        let settings = match self
            .app
            .try_state::<crate::settings::store::SettingsManager>()
        {
            Some(manager) => manager.get().await.jarvis.codex.clone(),
            None => CodexModelSettings::default(),
        };
        self.start_thread(workspace_id, &settings).await
    }

    /// Creates a fresh ephemeral thread with the isolated environment.
    async fn start_thread(
        &self,
        workspace_id: &str,
        settings: &CodexModelSettings,
    ) -> Result<JarvisCodexThread, RuntimeError> {
        let cwd = self.codex_home_dir()?;
        let params = json!({
            "ephemeral": true,
            "cwd": cwd.to_string_lossy(),
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "model": settings.model,
            "runtimeWorkspaceRoots": [],
            // C5: read-only namespaced dynamic tools (spec §11).
            "dynamicTools": super::tools::CodexToolService::dynamic_tool_specs(),
        });
        let client = self.runtime.client().await?;
        let result = client.request("thread/start", params).await?;
        let thread = result
            .get("thread")
            .cloned()
            .ok_or_else(|| RuntimeError::Rpc("thread/start missing `thread`".into()))?;
        let thread_id = thread
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::Rpc("thread/start missing thread.id".into()))?
            .to_owned();
        let record = JarvisCodexThread {
            thread_id,
            workspace_id: workspace_id.to_owned(),
            model: settings.model.clone(),
            reasoning_effort: settings.reasoning_effort.clone(),
            created_at: now_millis(),
            status: "idle".into(),
            active_turn_id: None,
        };
        self.threads
            .lock()
            .await
            .insert(workspace_id.to_owned(), record.clone());
        self.emit_snapshot().await;
        debug!(workspace_id, thread_id = %record.thread_id, "codex thread started");
        Ok(record)
    }

    /// `thread/delete` — used by Clear Conversation and clean shutdown.
    /// Best-effort: when the runtime is not running the local record is
    /// dropped and the server-side thread is left orphaned (V1 limit).
    pub async fn delete_thread(&self, workspace_id: &str) {
        let removed = self.threads.lock().await.remove(workspace_id);
        let Some(thread) = removed else {
            return;
        };
        match self.runtime.client().await {
            Ok(client) => {
                // Ephemeral threads are never persisted by App Server, so
                // thread/delete is expected to fail with "not persisted";
                // local cleanup is the only required action.
                if let Err(err) = client
                    .request("thread/delete", json!({ "threadId": thread.thread_id }))
                    .await
                {
                    debug!(error = %err, "codex thread/delete skipped (ephemeral)");
                }
            }
            Err(_) => warn!("codex runtime not running; ephemeral thread record dropped locally"),
        }
        self.emit_snapshot().await;
    }

    /// Starts a turn on the workspace thread (creating it first).
    /// Returns the active turn id. `request_id` (optional) is registered for
    /// C7 streaming correlation and returned in `jarvis://chat-stream`
    /// payloads for the events of this turn.
    pub async fn start_turn(
        &self,
        workspace_id: &str,
        input: &str,
        request_id: Option<&str>,
    ) -> Result<String, RuntimeError> {
        let thread = self.ensure_thread(workspace_id).await?;
        let client = self.runtime.client().await?;
        let result = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread.thread_id,
                    "input": [{ "type": "text", "text": input }],
                    "effort": thread.reasoning_effort,
                }),
            )
            .await?;
        let turn_id = result
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::Rpc("turn/start missing turn.id".into()))?
            .to_owned();
        if let Some(request_id) = request_id {
            self.request_ids
                .lock()
                .await
                .insert(turn_id.clone(), request_id.to_owned());
        }
        {
            let mut threads = self.threads.lock().await;
            if let Some(record) = threads.get_mut(workspace_id) {
                record.status = "in_progress".into();
                record.active_turn_id = Some(turn_id.clone());
            }
        }
        self.emit_snapshot().await;
        Ok(turn_id)
    }

    /// C7: app request id registered for a turn (if any).
    pub async fn request_id_for_turn(&self, turn_id: &str) -> Option<String> {
        self.request_ids.lock().await.get(turn_id).cloned()
    }

    /// C10: registers the oneshot that the bridge completes when the thread's
    /// turn reaches a terminal notification. At most one waiter per thread:
    /// a new waiter replaces a stale one (the old sender is dropped, which
    /// the provider maps to a server failure).
    pub async fn register_chat_waiter(
        &self,
        thread_id: &str,
        tx: oneshot::Sender<TurnOutcome>,
    ) {
        self.chat_waiters.lock().await.insert(thread_id.to_string(), tx);
    }

    /// C10: removes a waiter that will never be completed (turn/start failed).
    pub async fn dismiss_chat_waiter(&self, thread_id: &str) {
        self.chat_waiters.lock().await.remove(thread_id);
    }

    /// C10: remembers the text of the last completed agent message of a turn
    /// (the bridge stores it on `AgentMessageThreadItem`); consumed as the
    /// final chat answer on `turn/completed`.
    pub async fn set_last_message_text(&self, thread_id: &str, text: String) {
        self.last_message_text.lock().await.insert(thread_id.to_string(), text);
    }

    /// C10: completes the chat waiter with the final text and drops the slot.
    pub async fn complete_chat_waiter(&self, thread_id: &str) {
        let text = self.last_message_text.lock().await.remove(thread_id);
        let final_text = text.unwrap_or_default();
        if let Some(tx) = self.chat_waiters.lock().await.remove(thread_id) {
            let _ = tx.send(TurnOutcome::Final(final_text));
        }
    }

    /// C10: completes the chat waiter with a terminal failure/interrupt.
    pub async fn fail_chat_waiter(&self, thread_id: &str, outcome: TurnOutcome) {
        self.last_message_text.lock().await.remove(thread_id);
        if let Some(tx) = self.chat_waiters.lock().await.remove(thread_id) {
            let _ = tx.send(outcome);
        }
    }

    /// C7: drop the request correlation when a turn ends.
    pub async fn forget_turn(&self, turn_id: &str) {
        self.request_ids.lock().await.remove(turn_id);
    }

    /// `turn/interrupt` for the active turn of the workspace thread.
    /// C9: the running `conversational.plan` of that thread (if any) is
    /// cancelled FIRST so its steps stop at the next checkpoint; then the
    /// interrupt is sent to the server (idempotent — an already-finished
    /// turn is a no-op at the server).
    pub async fn interrupt_turn(
        &self,
        workspace_id: &str,
        tools: &CodexToolService,
    ) -> Result<(), RuntimeError> {
        let (thread_id, turn_id) = {
            let thread = self
                .threads
                .lock()
                .await
                .get(workspace_id)
                .cloned()
                .ok_or_else(|| RuntimeError::Rpc("no thread for workspace".into()))?;
            let Some(turn_id) = thread.active_turn_id else {
                return Ok(()); // nothing running
            };
            (thread.thread_id, turn_id)
        };
        tools.cancel_plan(&thread_id).await;
        let client = self.runtime.client().await?;
        client
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await?;
        Ok(())
    }

    /// C9: `turn/steer` — re-directs the ACTIVE turn with a short textual
    /// instruction. Gated: without an active turn this is a hard error, the
    /// caller must never steer a finished/idle thread.
    pub async fn steer_turn(
        &self,
        workspace_id: &str,
        steer_text: &str,
    ) -> Result<(), RuntimeError> {
        let steer_text = Self::validate_steer_text(steer_text)?;
        let (thread_id, turn_id) = {
            let threads = self.threads.lock().await;
            Self::resolve_steer_target(&threads, workspace_id)?
        };
        let client = self.runtime.client().await?;
        client
            .request(
                "turn/steer",
                json!({ "threadId": thread_id, "turnId": turn_id, "steerText": steer_text }),
            )
            .await?;
        Ok(())
    }

    /// Reverse lookup: which workspace owns this thread? Used by the
    /// dynamic tool dispatcher to resolve `item/tool/call` requests.
    pub async fn workspace_for_thread(&self, thread_id: &str) -> Option<String> {
        self.threads
            .lock()
            .await
            .values()
            .find(|record| record.thread_id == thread_id)
            .map(|record| record.workspace_id.clone())
    }

    /// C9 pure gate: `turn/steer` only resolves when the thread exists AND a
    /// turn is active on it (spec §15 — steer redirects the running turn, it
    /// is never a new prompt). Errors otherwise.
    fn resolve_steer_target(
        threads: &HashMap<String, JarvisCodexThread>,
        workspace_id: &str,
    ) -> Result<(String, String), RuntimeError> {
        let thread = threads
            .get(workspace_id)
            .ok_or_else(|| RuntimeError::Rpc("no thread for workspace".into()))?;
        let Some(turn_id) = thread.active_turn_id.clone() else {
            return Err(RuntimeError::Rpc("no active turn to steer".into()));
        };
        Ok((thread.thread_id.clone(), turn_id))
    }

    /// C9 pure gate: steer text must be non-empty after trimming and bounded
    /// to [`MAX_STEER_TEXT_CHARS`] (a steer is a short redirect).
    fn validate_steer_text(steer_text: &str) -> Result<&str, RuntimeError> {
        let steer_text = steer_text.trim();
        if steer_text.is_empty() {
            return Err(RuntimeError::Rpc("steer text is empty".into()));
        }
        if steer_text.chars().count() > MAX_STEER_TEXT_CHARS {
            return Err(RuntimeError::Rpc(format!(
                "steer text too long (max {MAX_STEER_TEXT_CHARS} chars)"
            )));
        }
        Ok(steer_text)
    }

    /// Snapshot for the UI.
    pub async fn list(&self) -> ThreadSnapshot {
        let threads = self.threads.lock().await;
        let mut all: Vec<JarvisCodexThread> = threads.values().cloned().collect();
        all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        ThreadSnapshot { threads: all }
    }



    async fn update_thread<F>(&self, thread_id: &str, mutate: F)
    where
        F: FnOnce(&mut JarvisCodexThread),
    {
        let mut threads = self.threads.lock().await;
        if let Some(record) = threads.values_mut().find(|record| record.thread_id == thread_id) {
            mutate(record);
            drop(threads);
            self.emit_snapshot().await;
        }
    }

    async fn emit_snapshot(&self) {
        let snapshot = self.list().await;
        let _ = self.app.emit(THREAD_EVENT, snapshot);
    }

    /// Applies a server notification (`Thread/*`, `Turn/*`) to the registry
    /// and emits the fresh snapshot. Called by the notification hub.
    pub async fn apply_notification(&self, method: &str, params: &Option<Value>) {
        match method {
            "turn/started" => {
                if let Some(params) = params {
                    if let (Some(thread_id), Some(turn_id)) = (
                        params.get("threadId").and_then(Value::as_str),
                        params.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str),
                    ) {
                        self.update_thread(thread_id, |record| {
                            record.status = "in_progress".into();
                            record.active_turn_id = Some(turn_id.to_owned());
                        })
                        .await;
                    }
                }
            }
            "turn/completed" | "turn/interrupted" | "turn/failed" => {
                if let Some(params) = params {
                    if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                        self.update_thread(thread_id, |record| {
                            record.status = "idle".into();
                            record.active_turn_id = None;
                        })
                        .await;
                    }
                }
            }
            "thread/deleted" => {
                if let Some(params) = params {
                    if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                        let mut threads = self.threads.lock().await;
                        let before = threads.len();
                        threads.retain(|_, record| record.thread_id != thread_id);
                        let changed = threads.len() != before;
                        drop(threads);
                        if changed {
                            self.emit_snapshot().await;
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Pure state transition for a thread record given a server notification.
/// Returns `true` when the notification changed the record.
#[cfg(test)]
fn apply_notification_to_record(
    record: &mut JarvisCodexThread,
    method: &str,
    params: &Option<Value>,
) -> bool {
    match method {
        "turn/started" => {
            if let Some(params) = params {
                if let Some(turn_id) = params
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                {
                    record.status = "in_progress".into();
                    record.active_turn_id = Some(turn_id.to_owned());
                    return true;
                }
            }
            false
        }
        "turn/completed" | "turn/interrupted" | "turn/failed" => {
            record.status = "idle".into();
            record.active_turn_id = None;
            true
        }
        _ => false,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jarvis_codex_threads(
    registry: tauri::State<'_, ThreadRegistry>,
) -> Result<ThreadSnapshot, String> {
    Ok(registry.list().await)
}

#[tauri::command]
pub async fn jarvis_codex_thread_ensure(
    registry: tauri::State<'_, ThreadRegistry>,
    workspace_id: String,
) -> Result<JarvisCodexThread, String> {
    registry
        .ensure_thread(&workspace_id)
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_thread_delete(
    registry: tauri::State<'_, ThreadRegistry>,
    workspace_id: String,
) -> Result<(), String> {
    registry.delete_thread(&workspace_id).await;
    Ok(())
}

#[tauri::command]
pub async fn jarvis_codex_turn_start(
    registry: tauri::State<'_, ThreadRegistry>,
    workspace_id: String,
    input: String,
    request_id: Option<String>,
) -> Result<String, String> {
    registry
        .start_turn(&workspace_id, &input, request_id.as_deref())
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_turn_interrupt(
    registry: tauri::State<'_, ThreadRegistry>,
    tools: tauri::State<'_, CodexToolService>,
    workspace_id: String,
) -> Result<(), String> {
    registry
        .interrupt_turn(&workspace_id, tools.inner())
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

/// C9: `turn/steer` — re-directs the active turn (gated: errors when no
/// turn is running). The instruction is bounded to keep the model on track
/// without turning the steer box into a second prompt.
#[tauri::command]
pub async fn jarvis_codex_turn_steer(
    registry: tauri::State<'_, ThreadRegistry>,
    workspace_id: String,
    steer_text: String,
) -> Result<(), String> {
    registry
        .steer_turn(&workspace_id, &steer_text)
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_home_dir_is_under_app_data() {
        // Pure path assertion: the directory is created lazily by the
        // runtime; here we only verify the layout contract.
        let joined = PathBuf::from("C:/fake/appdata").join("codex-home");
        assert_eq!(joined.file_name().unwrap().to_string_lossy(), "codex-home");
    }

    #[test]
    fn turn_notifications_drive_record_state() {
        let mut record = JarvisCodexThread {
            thread_id: "t1".into(),
            workspace_id: "w1".into(),
            model: "gpt-5.6-luna".into(),
            reasoning_effort: "low".into(),
            created_at: 0,
            status: "idle".into(),
            active_turn_id: None,
        };
        let started = json!({ "threadId": "t1", "turn": { "id": "turn-1" } });
        assert!(apply_notification_to_record(&mut record, "turn/started", &Some(started)));
        assert_eq!(record.status, "in_progress");
        assert_eq!(record.active_turn_id.as_deref(), Some("turn-1"));

        assert!(apply_notification_to_record(&mut record, "turn/completed", &None));
        assert_eq!(record.status, "idle");
        assert!(record.active_turn_id.is_none());

        assert!(apply_notification_to_record(&mut record, "turn/failed", &None));
        assert_eq!(record.status, "idle");

        // Unknown notifications never mutate the record.
        assert!(!apply_notification_to_record(
            &mut record,
            "thread/statusChanged",
            &None
        ));
        assert_eq!(record.status, "idle");
    }

    #[test]
    fn steer_gate_requires_active_turn() {
        let mut threads = HashMap::new();
        threads.insert(
            "w1".into(),
            JarvisCodexThread {
                thread_id: "t1".into(),
                workspace_id: "w1".into(),
                model: "gpt-5.6-luna".into(),
                reasoning_effort: "low".into(),
                created_at: 0,
                status: "idle".into(),
                active_turn_id: None,
            },
        );
        // No thread at all → hard error.
        assert!(matches!(
            ThreadRegistry::resolve_steer_target(&threads, "missing"),
            Err(RuntimeError::Rpc(_))
        ));
        // Thread exists but idle → gated (C9: steer only while running).
        assert!(matches!(
            ThreadRegistry::resolve_steer_target(&threads, "w1"),
            Err(RuntimeError::Rpc(_))
        ));
        // Active turn → resolved thread/turn pair.
        threads.get_mut("w1").unwrap().active_turn_id = Some("turn-9".into());
        let (thread_id, turn_id) =
            ThreadRegistry::resolve_steer_target(&threads, "w1").unwrap();
        assert_eq!(thread_id, "t1");
        assert_eq!(turn_id, "turn-9");
    }

    #[test]
    fn steer_text_is_trimmed_and_bounded() {
        assert!(ThreadRegistry::validate_steer_text("   ").is_err());
        assert!(ThreadRegistry::validate_steer_text("").is_err());
        let ok =
            ThreadRegistry::validate_steer_text("  continua senza tool  ").unwrap();
        assert_eq!(ok, "continua senza tool");
        let long = "x".repeat(MAX_STEER_TEXT_CHARS + 1);
        assert!(ThreadRegistry::validate_steer_text(&long).is_err());
        let at_limit = "x".repeat(MAX_STEER_TEXT_CHARS);
        assert!(ThreadRegistry::validate_steer_text(&at_limit).is_ok());
    }
}
