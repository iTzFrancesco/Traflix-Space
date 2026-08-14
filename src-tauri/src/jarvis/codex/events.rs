//! C7 — Streaming conversation events.
//!
//! Canonical Codex App Server wire methods are `item/started`,
//! `item/completed`, `item/agentMessage/delta` and `turn/completed`.
//! Legacy aliases observed by older builds are accepted defensively, but
//! reasoning payloads are never forwarded to the Jarvis UI.

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    pub kind: ChatStreamEventKind,
    pub request_id: Option<String>,
    pub workspace_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: Option<String>,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub timestamp: String,
}

const ITEM_KIND_AGENT_MESSAGE: &str = "agentMessage";
const ITEM_KIND_TOOL_CALL: &str = "dynamicToolCall";
const ITEM_KIND_REASONING: &str = "reasoning";

pub(crate) fn stream_events_from_notification(
    method: &str,
    params: &Option<Value>,
    workspace_id: &str,
    request_id: Option<&str>,
) -> Vec<ChatStreamEvent> {
    let Some(params) = params else {
        return Vec::new();
    };
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
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
        // Current App Server ends every turn with turn/completed and puts the
        // terminal outcome in turn.status. Some compatible builds include
        // the final agentMessage only inside turn.items, without emitting an
        // item/completed notification. Surface that item before the terminal
        // event so progressive TTS and the visible reducer have one canonical
        // final-message boundary.
        "turn/completed" => {
            let kind = turn_completed_kind(params);
            let mut events = Vec::new();
            if kind == ChatStreamEventKind::TurnCompleted {
                if let Some(event) = final_turn_message_event(&base, params) {
                    events.push(event);
                }
            }
            events.push(base(kind));
            events
        }
        "turn/failed" => vec![base(ChatStreamEventKind::TurnFailed)],
        "turn/interrupted" => vec![base(ChatStreamEventKind::TurnInterrupted)],
        "item/started" => item_event(base, params, false),
        "item/completed" => item_event(base, params, true),
        "item/agentMessage/delta" | "AgentMessageDelta" => {
            let (item_id, text) = delta_text(params);
            let Some(text) = text else {
                debug!(
                    method,
                    "agent message delta without recognizable text payload"
                );
                return Vec::new();
            };
            let mut event = base(ChatStreamEventKind::MessageDelta);
            event.item_id = item_id;
            event.text = Some(text);
            vec![event]
        }
        "AgentMessageThreadItem" => {
            let (item_id, item_type, text) = item_identity(params);
            if item_type.as_deref() != Some(ITEM_KIND_AGENT_MESSAGE) {
                return Vec::new();
            }
            let mut event = base(ChatStreamEventKind::MessageCompleted);
            event.item_id = item_id.or_else(|| {
                params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            event.text = text.or_else(|| extract_text(params));
            vec![event]
        }
        _ => Vec::new(),
    }
}

fn turn_completed_kind(params: &Value) -> ChatStreamEventKind {
    let status = params
        .get("turn")
        .and_then(|turn| turn.get("status"))
        .and_then(Value::as_str)
        .or_else(|| params.get("status").and_then(Value::as_str));
    match status {
        Some("failed") => ChatStreamEventKind::TurnFailed,
        Some("interrupted") => ChatStreamEventKind::TurnInterrupted,
        _ => ChatStreamEventKind::TurnCompleted,
    }
}

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
            let item = params.get("item").unwrap_or(params);
            let namespace = item
                .get("namespace")
                .and_then(Value::as_str)
                .or_else(|| params.get("namespace").and_then(Value::as_str))
                .unwrap_or_default();
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .or_else(|| params.get("tool").and_then(Value::as_str))
                .unwrap_or_default();
            event.tool_name = if !namespace.is_empty() && !tool.is_empty() {
                Some(format!("{namespace}.{tool}"))
            } else {
                event.item_id.clone()
            };
            vec![event]
        }
        Some(ITEM_KIND_REASONING) => Vec::new(),
        other => {
            debug!(
                item_kind = other.unwrap_or("unknown"),
                "codex streaming: item kind not surfaced"
            );
            Vec::new()
        }
    }
}

fn final_turn_message_event(
    base: &impl Fn(ChatStreamEventKind) -> ChatStreamEvent,
    params: &Value,
) -> Option<ChatStreamEvent> {
    let turn_id = turn_id_of(params);
    let item = params
        .get("turn")
        .and_then(|turn| turn.get("items"))
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().rev().find(|item| {
                item.get("type").and_then(Value::as_str) == Some(ITEM_KIND_AGENT_MESSAGE)
                    && extract_text(item).is_some()
            })
        })?;
    let mut event = base(ChatStreamEventKind::MessageCompleted);
    event.item_id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| Some(format!("final-{turn_id}")));
    event.text = extract_text(item);
    Some(event)
}

/// Canonical agentMessage is `{ id, type: "agentMessage", text }`.
/// Legacy content-block shapes are accepted too.
fn item_identity(params: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let item = params.get("item").unwrap_or(params);
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            params
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
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

fn delta_text(params: &Value) -> (Option<String>, Option<String>) {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let delta = params.get("delta");
    let text = delta
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            delta
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            delta
                .and_then(|value| value.get("content"))
                .and_then(Value::as_array)
                .and_then(|blocks| {
                    blocks.iter().find_map(|block| {
                        block.get("text").and_then(Value::as_str).map(str::to_owned)
                    })
                })
        });
    (item_id, text)
}

fn extract_text(value: &Value) -> Option<String> {
    // Canonical App Server ThreadItem::agentMessage.
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return Some(text.to_owned());
        }
    }
    if let Some(content) = value.get("content") {
        if let Some(text) = content.as_str() {
            if !text.is_empty() {
                return Some(text.to_owned());
            }
        }
        if let Some(blocks) = content.as_array() {
            let parts: Vec<String> = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .collect();
            if !parts.is_empty() {
                return Some(parts.join(""));
            }
        }
    }
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_owned)
}

pub(crate) fn turn_id_of(params: &Value) -> String {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
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
    fn current_turn_completed_status_maps_terminal_outcome() {
        for (status, expected) in [
            ("completed", ChatStreamEventKind::TurnCompleted),
            ("failed", ChatStreamEventKind::TurnFailed),
            ("interrupted", ChatStreamEventKind::TurnInterrupted),
        ] {
            let params = Some(json!({
                "threadId": "t",
                "turn": { "id": "turn-1", "status": status }
            }));
            assert_eq!(
                kinds(&stream_events_from_notification(
                    "turn/completed",
                    &params,
                    "w",
                    None,
                )),
                vec![expected]
            );
        }
    }

    #[test]
    fn completed_turn_items_surface_a_final_message_before_terminal_event() {
        let params = Some(json!({
            "threadId": "t",
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "items": [
                    { "id": "tool", "type": "dynamicToolCall" },
                    { "id": "final", "type": "agentMessage", "text": "Fatto." }
                ]
            }
        }));
        let events = stream_events_from_notification("turn/completed", &params, "w", None);
        assert_eq!(
            kinds(&events),
            vec![
                ChatStreamEventKind::MessageCompleted,
                ChatStreamEventKind::TurnCompleted
            ]
        );
        assert_eq!(events[0].item_id.as_deref(), Some("final"));
        assert_eq!(events[0].text.as_deref(), Some("Fatto."));
    }

    #[test]
    fn turn_started_is_observable_only_with_exact_thread_and_turn_ids() {
        let started = Some(json!({
            "threadId": "thread-routing-1",
            "turn": { "id": "turn-routing-7" }
        }));
        let events = stream_events_from_notification(
            "turn/started",
            &started,
            "workspace-routing",
            Some("request-routing-1"),
        );
        assert_eq!(kinds(&events), vec![ChatStreamEventKind::TurnStarted]);
        assert_eq!(events[0].workspace_id, "workspace-routing");
        assert_eq!(events[0].thread_id, "thread-routing-1");
        assert_eq!(events[0].turn_id, "turn-routing-7");
        assert_eq!(events[0].request_id.as_deref(), Some("request-routing-1"));

        let missing_turn_id = Some(json!({ "threadId": "thread-routing-1" }));
        assert!(stream_events_from_notification(
            "turn/started",
            &missing_turn_id,
            "workspace-routing",
            Some("request-routing-1"),
        )
        .is_empty());

        let missing_thread_id = Some(json!({
            "turn": { "id": "turn-routing-7" }
        }));
        assert!(stream_events_from_notification(
            "turn/started",
            &missing_thread_id,
            "workspace-routing",
            Some("request-routing-1"),
        )
        .is_empty());
    }

    #[test]
    fn canonical_agent_message_text_is_forwarded() {
        let completed = Some(json!({
            "threadId": "t",
            "turnId": "turn-1",
            "item": { "id": "item-1", "type": "agentMessage", "text": "Ok, controllo." }
        }));
        let events = stream_events_from_notification("item/completed", &completed, "w", None);
        assert_eq!(kinds(&events), vec![ChatStreamEventKind::MessageCompleted]);
        assert_eq!(events[0].text.as_deref(), Some("Ok, controllo."));
    }

    #[test]
    fn official_and_legacy_delta_methods_are_supported() {
        for method in ["item/agentMessage/delta", "AgentMessageDelta"] {
            let params = Some(json!({
                "threadId": "t",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "ciao"
            }));
            let events = stream_events_from_notification(method, &params, "w", Some("r1"));
            assert_eq!(kinds(&events), vec![ChatStreamEventKind::MessageDelta]);
            assert_eq!(events[0].text.as_deref(), Some("ciao"));
            assert_eq!(events[0].request_id.as_deref(), Some("r1"));
        }
    }

    #[test]
    fn reasoning_items_are_never_forwarded() {
        let reasoning = Some(json!({
            "threadId": "t",
            "turnId": "turn-1",
            "item": { "id": "item-3", "type": "reasoning", "text": "private" }
        }));
        for method in ["item/started", "item/completed"] {
            assert!(stream_events_from_notification(method, &reasoning, "w", None).is_empty());
        }
    }

    #[test]
    fn dynamic_tool_lifecycle_is_forwarded_without_output() {
        let tool = Some(json!({
            "threadId": "t",
            "turnId": "turn-1",
            "item": {
                "id": "item-2",
                "type": "dynamicToolCall",
                "namespace": "agent",
                "tool": "list"
            }
        }));
        let events = stream_events_from_notification("item/started", &tool, "w", None);
        assert_eq!(kinds(&events), vec![ChatStreamEventKind::ToolStarted]);
        assert_eq!(events[0].tool_name.as_deref(), Some("agent.list"));
        assert_eq!(events[0].text, None);
    }
}
