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

#[path = "thread_policy.rs"]
mod thread_policy;

use super::runtime::{CodexRuntimeManager, RuntimeError};
use super::tools::CodexToolService;
use crate::settings::store::CodexModelSettings;

pub(crate) use thread_policy::codex_home_dir;

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
    /// Review: runtime generation that created this thread. Ephemeral
    /// threads live in the App Server process memory: after a crash/restart
    /// the record is stale and must be recreated. Never serialized.
    #[serde(skip)]
    pub runtime_generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub threads: Vec<JarvisCodexThread>,
}

#[derive(Clone, Debug)]
pub enum TurnOutcome {
    Final(String),
    Failed(String),
    Interrupted,
}

struct ChatWaiter {
    request_id: String,
    sender: oneshot::Sender<TurnOutcome>,
}

#[derive(Clone)]
pub struct ThreadRegistry {
    runtime: CodexRuntimeManager,
    app: AppHandle,
    threads: Arc<Mutex<HashMap<String, JarvisCodexThread>>>,
    request_ids: Arc<Mutex<HashMap<String, String>>>,
    chat_waiters: Arc<Mutex<HashMap<String, ChatWaiter>>>,
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

    pub fn codex_home_dir(&self) -> Result<PathBuf, RuntimeError> {
        codex_home_dir(&self.app)
    }

    pub async fn ensure_thread(
        &self,
        workspace_id: &str,
    ) -> Result<JarvisCodexThread, RuntimeError> {
        let settings = match self
            .app
            .try_state::<crate::settings::store::SettingsManager>()
        {
            Some(manager) => manager.get().await.jarvis.codex.clone(),
            None => CodexModelSettings::default(),
        };
        let generation = self.runtime.generation().await;
        {
            let threads = self.threads.lock().await;
            if let Some(thread) = threads.get(workspace_id) {
                if thread.runtime_generation == generation
                    && thread.model == settings.model
                    && thread.reasoning_effort == settings.reasoning_effort
                {
                    return Ok(thread.clone());
                }
            }
        }
        self.start_thread(workspace_id, &settings).await
    }

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
            runtime_generation: self.runtime.generation().await,
        };
        self.threads
            .lock()
            .await
            .insert(workspace_id.to_owned(), record.clone());
        self.emit_snapshot().await;
        debug!(workspace_id, thread_id = %record.thread_id, "codex thread started");
        Ok(record)
    }

    pub async fn delete_thread(&self, workspace_id: &str) {
        let removed = self.threads.lock().await.remove(workspace_id);
        let Some(thread) = removed else {
            return;
        };
        match self.runtime.client().await {
            Ok(client) => {
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

    pub async fn request_id_for_turn(&self, turn_id: &str) -> Option<String> {
        self.request_ids.lock().await.get(turn_id).cloned()
    }

    /// Terminal notifications are allowed to affect a waiter only when their
    /// explicit turn id is still the turn advertised by this thread. An
    /// id-less notification is deliberately rejected: clearing a current
    /// turn without an identity can complete the wrong request.
    pub async fn terminal_turn_matches(&self, thread_id: &str, turn_id: &str) -> bool {
        self.active_turn_matches(thread_id, turn_id).await
    }

    pub async fn active_turn_matches(&self, thread_id: &str, turn_id: &str) -> bool {
        let threads = self.threads.lock().await;
        threads
            .values()
            .find(|record| record.thread_id == thread_id)
            .is_some_and(|record| terminal_turn_matches_record(record, Some(turn_id)))
    }

    pub async fn register_chat_waiter(
        &self,
        thread_id: &str,
        request_id: &str,
        tx: oneshot::Sender<TurnOutcome>,
    ) {
        // A waiter is the ownership boundary for one Codex turn. Any text
        // left by an interrupted/expired turn must not be eligible as the
        // final answer of the next request on the same thread.
        self.last_message_text.lock().await.remove(thread_id);
        self.chat_waiters.lock().await.insert(
            thread_id.to_string(),
            ChatWaiter {
                request_id: request_id.to_owned(),
                sender: tx,
            },
        );
    }

    pub async fn dismiss_chat_waiter(&self, thread_id: &str, request_id: &str) -> bool {
        let dismissed = {
            let mut waiters = self.chat_waiters.lock().await;
            if waiters
                .get(thread_id)
                .is_some_and(|waiter| waiter.request_id == request_id)
            {
                waiters.remove(thread_id).is_some()
            } else {
                false
            }
        };
        if dismissed {
            self.last_message_text.lock().await.remove(thread_id);
        }
        dismissed
    }

    pub async fn set_last_message_text(&self, thread_id: &str, text: String) {
        self.last_message_text
            .lock()
            .await
            .insert(thread_id.to_string(), text);
    }

    /// A terminal payload is only a fallback. If an item/completed event has
    /// already supplied text for this turn, keep that event-owned value and
    /// do not let a stale/incomplete turn snapshot replace it.
    pub async fn set_last_message_text_if_absent(&self, thread_id: &str, text: String) {
        let mut messages = self.last_message_text.lock().await;
        store_message_if_absent(&mut messages, thread_id, text);
    }

    pub async fn complete_chat_waiter(&self, thread_id: &str) {
        let text = self.last_message_text.lock().await.remove(thread_id);
        let final_text = text.unwrap_or_default();
        if let Some(waiter) = self.chat_waiters.lock().await.remove(thread_id) {
            let _ = waiter.sender.send(TurnOutcome::Final(final_text));
        }
    }

    pub async fn fail_chat_waiter(&self, thread_id: &str, outcome: TurnOutcome) {
        self.last_message_text.lock().await.remove(thread_id);
        if let Some(waiter) = self.chat_waiters.lock().await.remove(thread_id) {
            let _ = waiter.sender.send(outcome);
        }
    }

    /// Fails exactly the waiter owned by a request, even when the outer chat
    /// timeout dropped the provider future before a terminal RPC arrived.
    pub async fn fail_chat_waiter_for_request(
        &self,
        request_id: &str,
        outcome: TurnOutcome,
    ) -> bool {
        let (thread_id, waiter) = {
            let mut waiters = self.chat_waiters.lock().await;
            let thread_id = waiters.iter().find_map(|(thread_id, waiter)| {
                (waiter.request_id == request_id).then_some(thread_id.clone())
            });
            let Some(thread_id) = thread_id else {
                return false;
            };
            let waiter = waiters
                .remove(&thread_id)
                .expect("chat waiter found immediately before removal");
            (thread_id, waiter)
        };
        self.last_message_text.lock().await.remove(&thread_id);
        let _ = waiter.sender.send(outcome);
        true
    }

    pub async fn on_runtime_crashed(&self) {
        self.fail_all_waiters().await;
        self.request_ids.lock().await.clear();
    }

    pub async fn on_runtime_restarted(&self, generation: u64) {
        self.fail_all_waiters().await;
        self.request_ids.lock().await.clear();
        self.last_message_text.lock().await.clear();
        retain_current_generation(&mut *self.threads.lock().await, generation);
        self.emit_snapshot().await;
    }

    async fn fail_all_waiters(&self) {
        let waiters = {
            let mut map = self.chat_waiters.lock().await;
            std::mem::take(&mut *map)
        };
        let mut last_message_text = self.last_message_text.lock().await;
        for (thread_id, waiter) in waiters {
            last_message_text.remove(&thread_id);
            let _ = waiter.sender.send(TurnOutcome::Interrupted);
        }
    }

    pub async fn interrupt_turn(
        &self,
        workspace_id: &str,
        tools: &CodexToolService,
    ) -> Result<(), RuntimeError> {
        let turn_id = {
            let thread = self
                .threads
                .lock()
                .await
                .get(workspace_id)
                .cloned()
                .ok_or_else(|| RuntimeError::Rpc("no thread for workspace".into()))?;
            let Some(turn_id) = thread.active_turn_id else {
                return Ok(());
            };
            turn_id
        };
        self.interrupt_turn_id(workspace_id, &turn_id, tools).await
    }

    /// Interrupts only the turn that the caller started. A newer turn on the
    /// same workspace is left untouched when cancellation arrives late.
    pub async fn interrupt_turn_id(
        &self,
        workspace_id: &str,
        expected_turn_id: &str,
        tools: &CodexToolService,
    ) -> Result<(), RuntimeError> {
        let thread_id = {
            let thread = self
                .threads
                .lock()
                .await
                .get(workspace_id)
                .cloned()
                .ok_or_else(|| RuntimeError::Rpc("no thread for workspace".into()))?;
            if thread.active_turn_id.as_deref() != Some(expected_turn_id) {
                return Ok(());
            }
            thread.thread_id
        };
        let turn_id = expected_turn_id.to_owned();
        tools.cancel_plan(&thread_id, &turn_id).await;
        // Cancellation is a recovery boundary. Even if the App Server has
        // already forgotten the turn (or the notification was lost), the
        // local registry must not keep advertising a turn that the server no
        // longer owns. The expected id prevents a late interrupt from
        // clearing a newer turn on the same workspace.
        let result = match self.runtime.client().await {
            Ok(client) => client
                .request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": turn_id }),
                )
                .await
                .map(|_| ())
                .map_err(RuntimeError::from),
            Err(error) => Err(error),
        };
        self.clear_active_turn(workspace_id, Some(&turn_id)).await;
        result
    }

    /// Resolves a request to its current turn before interrupting it. This is
    /// used by the outer chat timeout after the provider task was dropped.
    pub async fn interrupt_turn_for_request(
        &self,
        request_id: &str,
        tools: &CodexToolService,
    ) -> Result<(), RuntimeError> {
        // Resolve the provider waiter before clearing the turn/request map;
        // otherwise an outer timeout or manual cancel can leave the model
        // future waiting for a terminal event that we intentionally ignore.
        self.fail_chat_waiter_for_request(request_id, TurnOutcome::Interrupted)
            .await;
        let turn_id = {
            let request_ids = self.request_ids.lock().await;
            request_ids
                .iter()
                .find_map(|(turn_id, owner)| (owner == request_id).then_some(turn_id.clone()))
        };
        let Some(turn_id) = turn_id else {
            return Ok(());
        };
        let workspace_id = {
            let threads = self.threads.lock().await;
            threads.iter().find_map(|(workspace_id, record)| {
                (record.active_turn_id.as_deref() == Some(turn_id.as_str()))
                    .then_some(workspace_id.clone())
            })
        };
        let Some(workspace_id) = workspace_id else {
            return Ok(());
        };
        self.interrupt_turn_id(&workspace_id, &turn_id, tools).await
    }

    /// Clears a locally advertised turn when its caller has reached a
    /// terminal boundary (cancel, timeout, runtime recovery). The optional
    /// turn id makes this operation idempotent and protects a newer turn from
    /// a late cleanup belonging to an older one.
    pub async fn clear_active_turn(
        &self,
        workspace_id: &str,
        expected_turn_id: Option<&str>,
    ) -> bool {
        let (turn_id, changed) = {
            let mut threads = self.threads.lock().await;
            let Some(record) = threads.get_mut(workspace_id) else {
                return false;
            };
            let Some(current_turn_id) = record.active_turn_id.clone() else {
                return false;
            };
            if expected_turn_id.is_some_and(|expected| expected != current_turn_id) {
                return false;
            }
            record.active_turn_id = None;
            record.status = "idle".into();
            (current_turn_id, true)
        };
        if changed {
            self.request_ids.lock().await.remove(&turn_id);
            self.emit_snapshot().await;
        }
        changed
    }

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

    pub async fn workspace_for_thread(&self, thread_id: &str) -> Option<String> {
        self.threads
            .lock()
            .await
            .values()
            .find(|record| record.thread_id == thread_id)
            .map(|record| record.workspace_id.clone())
    }

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
        if let Some(record) = threads
            .values_mut()
            .find(|record| record.thread_id == thread_id)
        {
            mutate(record);
            drop(threads);
            self.emit_snapshot().await;
        }
    }

    async fn emit_snapshot(&self) {
        let snapshot = self.list().await;
        let _ = self.app.emit(THREAD_EVENT, snapshot);
    }

    pub async fn apply_notification(&self, method: &str, params: &Option<Value>) {
        match method {
            "turn/started" => {
                if let Some(params) = params {
                    if let (Some(thread_id), Some(turn_id)) = (
                        params.get("threadId").and_then(Value::as_str),
                        params
                            .get("turn")
                            .and_then(|t| t.get("id"))
                            .and_then(Value::as_str),
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
                        let reported_turn_id = notification_turn_id(&params);
                        // A delayed completion from an older turn must not
                        // close a newer turn. Terminal events without an
                        // identity are also ignored because they cannot be
                        // safely attributed to the active request.
                        let current_record = self
                            .threads
                            .lock()
                            .await
                            .values()
                            .find(|record| record.thread_id == thread_id)
                            .cloned();
                        if current_record.as_ref().is_none_or(|record| {
                            !terminal_turn_matches_record(record, reported_turn_id.as_deref())
                        }) {
                            return;
                        }
                        let current_turn_id =
                            current_record.and_then(|record| record.active_turn_id);
                        self.update_thread(thread_id, |record| {
                            record.status = "idle".into();
                            record.active_turn_id = None;
                        })
                        .await;
                        if let Some(turn_id) = reported_turn_id.or(current_turn_id) {
                            self.request_ids.lock().await.remove(&turn_id);
                        }
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

fn retain_current_generation(threads: &mut HashMap<String, JarvisCodexThread>, generation: u64) {
    threads.retain(|_, thread| thread.runtime_generation == generation);
}

fn notification_turn_id(params: &Value) -> Option<String> {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
}

fn terminal_turn_matches_record(
    record: &JarvisCodexThread,
    reported_turn_id: Option<&str>,
) -> bool {
    reported_turn_id.is_some_and(|reported| record.active_turn_id.as_deref() == Some(reported))
}

fn store_message_if_absent(messages: &mut HashMap<String, String>, thread_id: &str, text: String) {
    messages.entry(thread_id.to_owned()).or_insert(text);
}

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
            let reported_turn_id = params.as_ref().and_then(notification_turn_id);
            if !terminal_turn_matches_record(record, reported_turn_id.as_deref()) {
                return false;
            }
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
    fn threads_of_older_runtime_generations_are_dropped_on_restart() {
        let mut threads = HashMap::new();
        threads.insert(
            "w1".into(),
            JarvisCodexThread {
                thread_id: "t-old".into(),
                workspace_id: "w1".into(),
                model: "gpt-5.6-luna".into(),
                reasoning_effort: "low".into(),
                created_at: 0,
                status: "idle".into(),
                active_turn_id: None,
                runtime_generation: 1,
            },
        );
        threads.insert(
            "w2".into(),
            JarvisCodexThread {
                thread_id: "t-current".into(),
                workspace_id: "w2".into(),
                model: "gpt-5.6-luna".into(),
                reasoning_effort: "low".into(),
                created_at: 0,
                status: "idle".into(),
                active_turn_id: None,
                runtime_generation: 2,
            },
        );
        retain_current_generation(&mut threads, 2);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads["w2"].thread_id, "t-current");
        assert!(!threads.contains_key("w1"));
    }

    #[test]
    fn codex_home_dir_is_under_app_data() {
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
            runtime_generation: 1,
        };
        let started = json!({ "threadId": "t1", "turn": { "id": "turn-1" } });
        assert!(apply_notification_to_record(
            &mut record,
            "turn/started",
            &Some(started)
        ));
        assert_eq!(record.status, "in_progress");
        assert_eq!(record.active_turn_id.as_deref(), Some("turn-1"));

        assert!(apply_notification_to_record(
            &mut record,
            "turn/completed",
            &Some(json!({ "turn": { "id": "turn-1" } }))
        ));
        assert_eq!(record.status, "idle");
        assert!(record.active_turn_id.is_none());

        assert!(!apply_notification_to_record(
            &mut record,
            "turn/failed",
            &None
        ));
        assert_eq!(record.status, "idle");

        assert!(!apply_notification_to_record(
            &mut record,
            "thread/statusChanged",
            &None
        ));
        assert_eq!(record.status, "idle");
    }

    #[test]
    fn late_terminal_notification_cannot_clear_a_newer_turn() {
        let mut record = JarvisCodexThread {
            thread_id: "t1".into(),
            workspace_id: "w1".into(),
            model: "gpt-5.6-luna".into(),
            reasoning_effort: "low".into(),
            created_at: 0,
            status: "in_progress".into(),
            active_turn_id: Some("turn-new".into()),
            runtime_generation: 1,
        };
        let late_completion = json!({
            "threadId": "t1",
            "turn": { "id": "turn-old" }
        });
        assert!(!apply_notification_to_record(
            &mut record,
            "turn/completed",
            &Some(late_completion)
        ));
        assert_eq!(record.active_turn_id.as_deref(), Some("turn-new"));

        // Older App Server payloads without a turn id are rejected rather
        // than being allowed to clear the newer active turn.
        assert!(!apply_notification_to_record(
            &mut record,
            "turn/interrupted",
            &None
        ));
        assert_eq!(record.active_turn_id.as_deref(), Some("turn-new"));
    }

    #[test]
    fn terminal_turn_match_requires_the_current_explicit_turn_id() {
        let record = JarvisCodexThread {
            thread_id: "t1".into(),
            workspace_id: "w1".into(),
            model: "gpt-5.6-luna".into(),
            reasoning_effort: "low".into(),
            created_at: 0,
            status: "in_progress".into(),
            active_turn_id: Some("turn-new".into()),
            runtime_generation: 1,
        };
        assert!(terminal_turn_matches_record(&record, Some("turn-new")));
        assert!(!terminal_turn_matches_record(&record, Some("turn-old")));
        assert!(!terminal_turn_matches_record(&record, None));
    }

    #[test]
    fn terminal_fallback_does_not_replace_text_captured_from_current_turn() {
        let mut messages = HashMap::new();
        store_message_if_absent(&mut messages, "t1", "Risposta corrente".into());
        store_message_if_absent(&mut messages, "t1", "Risposta precedente".into());
        assert_eq!(
            messages.get("t1").map(String::as_str),
            Some("Risposta corrente")
        );
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
                runtime_generation: 1,
            },
        );
        assert!(matches!(
            ThreadRegistry::resolve_steer_target(&threads, "missing"),
            Err(RuntimeError::Rpc(_))
        ));
        assert!(matches!(
            ThreadRegistry::resolve_steer_target(&threads, "w1"),
            Err(RuntimeError::Rpc(_))
        ));
        threads.get_mut("w1").unwrap().active_turn_id = Some("turn-9".into());
        let (thread_id, turn_id) = ThreadRegistry::resolve_steer_target(&threads, "w1").unwrap();
        assert_eq!(thread_id, "t1");
        assert_eq!(turn_id, "turn-9");
    }

    #[test]
    fn steer_text_is_trimmed_and_bounded() {
        assert!(ThreadRegistry::validate_steer_text("   ").is_err());
        assert!(ThreadRegistry::validate_steer_text("").is_err());
        let ok = ThreadRegistry::validate_steer_text("  continua senza tool  ").unwrap();
        assert_eq!(ok, "continua senza tool");
        let long = "x".repeat(MAX_STEER_TEXT_CHARS + 1);
        assert!(ThreadRegistry::validate_steer_text(&long).is_err());
        let at_limit = "x".repeat(MAX_STEER_TEXT_CHARS);
        assert!(ThreadRegistry::validate_steer_text(&at_limit).is_ok());
    }
}
