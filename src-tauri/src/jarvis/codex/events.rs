//! C7 — Streaming conversation events.
//!
//! The App Server emits incremental notifications while a turn is alive:
//! `Item/started` / `Item/completed` (one per item: agentMessage,
//! dynamicToolCall, reasoning, …), `AgentMessageDelta` (incremental text of
//! the agent message) and `AgentMessageThreadItem` (the completed message
//! item). This module normalizes them into small typed [`ChatStreamEvent`]s
//! forwarded to the UI as `jarvis://chat-stream`.
//!
//! Protocol facts verified live on 0.147.0: agentMessage has NO `phase`
//! field (user correction #4) — the UI decides which completed message is
//! the final one (the last one before `turn/completed`). Raw `reasoning`
//! items are NEVER forwarded (spec §15: the UI must ignore them; we do not
//! even emit them).
//!
//! The exact `Item/*` and `AgentMessageDelta` payload shapes are parsed
//! defensively (multiple aliases, all optional); unknown shapes are logged
//! and skipped (fail closed, spec §25).

use serde::Serialize;
use serde_json::Value;
use tracing::debug;

/// Global Tauri event carrying normalized streaming events.
pub const CHAT_STREAM_EVENT: &str = "jarvis://chat-stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatStreamEventKind {
    TurnStarted,
    TurnCompleted,
    TurnFailed,
    TurnInterrupted,
    MessageStarted,
    MessageDelta,
    MessageCompleted,
    ToolStarted,
    ToolCompleted,
}

/// One normalized streaming event, forwarded to the UI. Never carries
/// credentials, raw reasoning or untrusted tool output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    pub kind: ChatStreamEventKind,
    /// App-level request id when the turn was started by a command that
    /// registered one; `None` for turns started outside the app.
    pub request_id: Option<String>,
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: Option<String>,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub timestamp: String,
}

/// Item kinds that map to visible streaming events. `reasoning` and unknown
/// kinds are deliberately dropped.
const ITEM_KIND_AGENT_MESSAGE: &str = "agentMessage";
const ITEM_KIND_TOOL_CALL: &str = "dynamicToolCall";
const ITEM_KIND_REASONING: &str = "reasoning";

/// Normalizes one server notification into streaming events.
/// `workspace_id` / `request_id` are resolved by the caller (thread binding).
pub(crate) fn stream_events_from_notification(
    method: &str,
    params: &Option<Value>,
    workspace_id: &str,
    request_id: Option<&str>,
) -> Vec<ChatStreamEvent> {
    let Some(params) = params else {
        return Vec::new();
    };
    let thread_id = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
    let turn_id = turn_id_of(params);
    if thread_id.is_empty() || turn_id.is_empty() {
        return Vec::new();
    }
    let base = |kind: ChatStreamEventKind| ChatStreamEvent {
        kind,
        request_id: request_id.map(str::to_owned),
        workspace_id: workspace_id.to_owned(),
        thread_id: thread_id.to_owned(),
        turn_id: turn_id.to_owned(),
        item_id: None,
        text: None,
        tool_name: None,
        timestamp: crate::jarvis::chat::now(),
    };

    match method {
        "turn/started" => vec![base(ChatStreamEventKind::TurnStarted)],
        "turn/completed" => vec![base(ChatStreamEventKind::TurnCompleted)],
        "turn/failed" => vec![base(ChatStreamEventKind::TurnFailed)],
        "turn/interrupted" => vec![base(ChatStreamEventKind::TurnInterrupted)],
        "item/started" => item_event(base, params, false),
        "item/completed" => item_event(base, params, true),
        // Incremental text of the in-flight agent message.
        "AgentMessageDelta" => {
            let (item_id, text) = delta_text(params);
            let Some(text) = text else {
                debug!(method, "AgentMessageDelta without recognizable text payload");
                return Vec::new();
            };
            let mut event = base(ChatStreamEventKind::MessageDelta);
            event.item_id = item_id;
            event.text = Some(text);
            vec![event]
        }
        // The completed agent message item (when the server emits it as a
        // notification of its own).
        "AgentMessageThreadItem" => {
            let (item_id, item_type, text) = item_identity(params);
            if item_type.as_deref() != Some(ITEM_KIND_AGENT_MESSAGE) {
                return Vec::new();
            }
            let mut event = base(ChatStreamEventKind::MessageCompleted);
            event.item_id = item_id.or_else(|| params.get("itemId").and_then(Value::as_str).map(str::to_owned));
            event.text = text.or_else(|| extract_text(params));
            vec![event]
        }
        _ => Vec::new(),
    }
}

/// Builds the `item/started|completed` event for the item in `params`.
fn item_event(
    base: impl Fn(ChatStreamEventKind) -> ChatStreamEvent,
    params: &Value,
    completed: bool,
) -> Vec<ChatStreamEvent> {
    let (item_id, item_type, text) = item_identity(params);
    match item_type.as_deref() {
        Some(ITEM_KIND_AGENT_MESSAGE) => {
            let mut event = base(if completed {
                ChatStreamEventKind::MessageCompleted
            } else {
                ChatStreamEventKind::MessageStarted
            });
            event.item_id = item_id;
            // A completed agent message may carry its full text inline.
            if completed {
                event.text = text.or_else(|| extract_text(params));
            }
            vec![event]
        }
        Some(ITEM_KIND_TOOL_CALL) => {
            let mut event = base(if completed {
                ChatStreamEventKind::ToolCompleted
            } else {
                ChatStreamEventKind::ToolStarted
            });
            event.item_id = item_id;
            // The dynamic tool call item usually carries namespace + tool
            // (like the `item/tool/call` server request); fall back to the
            // item id when not present.
            let namespace = params
                .get("namespace")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = params.get("tool").and_then(Value::as_str).unwrap_or_default();
            if !namespace.is_empty() && !tool.is_empty() {
                event.tool_name = Some(format!("{namespace}.{tool}"));
            } else {
                let item = params.get("item").unwrap_or(params);
                let namespace = item
                    .get("namespace")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or_default();
                if !namespace.is_empty() && !tool.is_empty() {
                    event.tool_name = Some(format!("{namespace}.{tool}"));
                } else {
                    event.tool_name = event.item_id.clone();
                }
            }
            vec![event]
        }
        Some(ITEM_KIND_REASONING) => {
            // Spec §15: raw reasoning is never shown. Drop it entirely.
            Vec::new()
        }
        other => {
            debug!(
                item_kind = other.unwrap_or("unknown"),
                "codex streaming: item kind not surfaced"
            );
            Vec::new()
        }
    }
}

/// Item identity, multi-alias: `item.id` + `item.type` (canonical) or
/// `itemId` + `itemType` (flat). Returns (item_id, item_type, inline_text).
fn item_identity(params: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let item = params.get("item").unwrap_or(params);
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| params.get("itemId").and_then(Value::as_str).map(str::to_owned));
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            params
                .get("itemType")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let text = extract_text(item).or_else(|| extract_text(params));
    (id, kind, text)
}

/// Delta text, multi-alias: `delta` string, `delta.text`, `delta.text` in a
/// `{type:"text_delta"}` block, or `delta.content` (single text block).
fn delta_text(params: &Value) -> (Option<String>, Option<String>) {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let delta = params.get("delta");
    let text = delta
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| delta.and_then(|d| d.get("text")).and_then(Value::as_str).map(str::to_owned))
        .or_else(|| {
            delta
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|blocks| {
                    blocks.iter().find_map(|block| {
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                })
        });
    (item_id, text)
}

/// Extracts the plain text of an agent message from common payload shapes:
/// `content` as array of `{type:"text", text}` blocks, `content` as string,
/// `text` as string, or `message` as string.
fn extract_text(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content") {
        if let Some(text) = content.as_str() {
            return Some(text.to_owned());
        }
        if let Some(blocks) = content.as_array() {
            let mut parts = Vec::new();
            for block in blocks {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                } else if let Some(block_type) = block.get("type").and_then(Value::as_str) {
                    // inputText blocks carry the text at `text` too; unknown
                    // block kinds (e.g. reasoning) are never forwarded.
                    if block_type == "inputText" {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            parts.push(text.to_owned());
                        }
                    }
                }
            }
            if !parts.is_empty() {
                return Some(parts.join(""));
            }
        }
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Some(message.to_owned());
    }
    None
}

/// Turn id extraction shared by the bridge (for request correlation).
pub(crate) fn turn_id_of(params: &Value) -> String {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            params
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kinds(events: &[ChatStreamEvent]) -> Vec<ChatStreamEventKind> {
        events.iter().map(|event| event.kind).collect()
    }

    #[test]
    fn turn_notifications_map_to_lifecycle_events() {
        let params = Some(json!({ "threadId": "t", "turnId": "turn-1" }));
        assert_eq!(
            kinds(&stream_events_from_notification("turn/started", &params, "w", None)),
            vec![ChatStreamEventKind::TurnStarted]
        );
        assert_eq!(
            kinds(&stream_events_from_notification("turn/completed", &params, "w", None)),
            vec![ChatStreamEventKind::TurnCompleted]
        );
        assert_eq!(
            kinds(&stream_events_from_notification("turn/failed", &params, "w", None)),
            vec![ChatStreamEventKind::TurnFailed]
        );
        assert_eq!(
            kinds(&stream_events_from_notification("turn/interrupted", &params, "w", None)),
            vec![ChatStreamEventKind::TurnInterrupted]
        );
        // Unknown methods produce nothing (fail closed).
        assert!(stream_events_from_notification("whatever", &params, "w", None).is_empty());
        // Missing thread/turn identity produces nothing.
        assert!(stream_events_from_notification(
            "turn/started",
            &Some(json!({ "threadId": "t" })),
            "w",
            None
        )
        .is_empty());
    }

    #[test]
    fn item_started_completed_map_message_and_tool_lifecycle() {
        let message = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": { "id": "item-1", "type": "agentMessage" }
        }));
        let events = stream_events_from_notification("item/started", &message, "w", Some("r1"));
        assert_eq!(
            kinds(&events),
            vec![ChatStreamEventKind::MessageStarted]
        );
        assert_eq!(events[0].item_id.as_deref(), Some("item-1"));
        assert_eq!(events[0].request_id.as_deref(), Some("r1"));

        let completed = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": {
                "id": "item-1",
                "type": "agentMessage",
                "content": [{ "type": "text", "text": "Ok, controllo." }]
            }
        }));
        let events = stream_events_from_notification("item/completed", &completed, "w", None);
        assert_eq!(
            kinds(&events),
            vec![ChatStreamEventKind::MessageCompleted]
        );
        assert_eq!(events[0].text.as_deref(), Some("Ok, controllo."));

        let tool = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": { "id": "item-2", "type": "dynamicToolCall", "namespace": "agent", "tool": "list" }
        }));
        let events = stream_events_from_notification("item/started", &tool, "w", None);
        assert_eq!(kinds(&events), vec![ChatStreamEventKind::ToolStarted]);
        assert_eq!(events[0].tool_name.as_deref(), Some("agent.list"));
    }

    #[test]
    fn reasoning_items_are_never_forwarded() {
        let reasoning = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": { "id": "item-3", "type": "reasoning", "content": "secret chain" }
        }));
        for method in ["item/started", "item/completed"] {
            assert!(
                stream_events_from_notification(method, &reasoning, "w", None).is_empty(),
                "{method} must drop reasoning"
            );
        }
        let unknown = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": { "id": "item-4", "type": "someFutureKind" }
        }));
        assert!(stream_events_from_notification("item/started", &unknown, "w", None).is_empty());
    }

    #[test]
    fn delta_text_accepts_string_block_and_text_delta_shapes() {
        for delta in [
            json!("ciao"),
            json!({ "text": "ciao" }),
            json!({ "type": "text_delta", "text": "ciao" }),
            json!({ "content": [{ "type": "text", "text": "ciao" }] }),
        ] {
            let params = Some(json!({
                "threadId": "t", "turnId": "turn-1", "itemId": "item-1", "delta": delta
            }));
            let events = stream_events_from_notification("AgentMessageDelta", &params, "w", None);
            assert_eq!(kinds(&events), vec![ChatStreamEventKind::MessageDelta]);
            assert_eq!(events[0].text.as_deref(), Some("ciao"));
        }
        // Delta without recognizable text is dropped.
        let broken = Some(json!({
            "threadId": "t", "turnId": "turn-1", "itemId": "item-1", "delta": json!({ "nope": 1 })
        }));
        assert!(stream_events_from_notification("AgentMessageDelta", &broken, "w", None).is_empty());
    }

    #[test]
    fn thread_item_notification_maps_to_completed_message() {
        let params = Some(json!({
            "threadId": "t", "turnId": "turn-1",
            "item": {
                "id": "item-1",
                "type": "agentMessage",
                "content": [{ "type": "text", "text": "Fatto." }]
            }
        }));
        let events = stream_events_from_notification("AgentMessageThreadItem", &params, "w", None);
        assert_eq!(
            kinds(&events),
            vec![ChatStreamEventKind::MessageCompleted]
        );
        assert_eq!(events[0].text.as_deref(), Some("Fatto."));
    }

    #[test]
    fn flat_item_aliases_are_supported() {
        let params = Some(json!({
            "threadId": "t", "turnId": "turn-1", "itemId": "flat-1", "itemType": "agentMessage"
        }));
        let events = stream_events_from_notification("item/started", &params, "w", None);
        assert_eq!(kinds(&events), vec![ChatStreamEventKind::MessageStarted]);
        assert_eq!(events[0].item_id.as_deref(), Some("flat-1"));
    }
}
