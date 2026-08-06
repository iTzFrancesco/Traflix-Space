use crate::jarvis::types::InvocationBinding;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_PENDING_ACTIONS: usize = 64;
const ACTION_TTL_MINUTES: i64 = 10;
pub const MAX_ACTION_TEXT_BYTES: usize = 16 * 1024;
static NEXT_ACTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingActionStatus {
    Pending,
    Confirmed,
    Rejected,
    Expired,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub operation: String,
    pub description: String,
    pub preview: String,
    pub editable_text: Option<String>,
    pub invocation: InvocationBinding,
    pub terminal_id: Option<String>,
    pub generation: Option<u64>,
    pub provider: Option<String>,
    pub status: PendingActionStatus,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone)]
pub struct PendingActionRecord {
    pub action: PendingAction,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct PendingActionInput {
    pub operation: String,
    pub description: String,
    pub preview: String,
    pub invocation: InvocationBinding,
    pub terminal_id: Option<String>,
    pub generation: Option<u64>,
    pub provider: Option<String>,
    pub editable_text: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    NotFound,
    NotPending,
    InvocationMismatch,
    Expired,
    PayloadInvalid,
}

#[derive(Default)]
pub struct PendingActionRegistry {
    actions: Mutex<HashMap<String, PendingActionRecord>>,
}

impl PendingActionRegistry {
    pub fn create(&self, input: PendingActionInput) -> PendingAction {
        let now = Utc::now();
        let action = PendingAction {
            id: format!("jarvis-action:{}", uuid_like_id()),
            operation: input.operation,
            description: input.description,
            preview: input.preview,
            editable_text: input.editable_text,
            invocation: input.invocation,
            terminal_id: input.terminal_id,
            generation: input.generation,
            provider: input.provider,
            status: PendingActionStatus::Pending,
            created_at: now.to_rfc3339(),
            expires_at: (now + Duration::minutes(ACTION_TTL_MINUTES)).to_rfc3339(),
        };
        if let Ok(mut actions) = self.actions.lock() {
            actions.insert(
                action.id.clone(),
                PendingActionRecord {
                    action: action.clone(),
                    payload: input.payload,
                },
            );
            prune_actions(&mut actions);
        }
        action
    }

    pub fn list(&self) -> Vec<PendingAction> {
        let now = Utc::now().to_rfc3339();
        let Ok(mut actions) = self.actions.lock() else {
            return Vec::new();
        };
        for record in actions.values_mut() {
            if record.action.status == PendingActionStatus::Pending
                && record.action.expires_at < now
            {
                record.action.status = PendingActionStatus::Expired;
            }
        }
        let mut result = actions
            .values()
            .map(|record| record.action.clone())
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        result
    }

    pub fn take_for_confirmation(
        &self,
        action_id: &str,
        invocation: &InvocationBinding,
    ) -> Result<PendingActionRecord, ActionError> {
        let Ok(mut actions) = self.actions.lock() else {
            return Err(ActionError::NotFound);
        };
        let Some(record) = actions.get_mut(action_id) else {
            return Err(ActionError::NotFound);
        };
        if record.action.status != PendingActionStatus::Pending {
            return Err(ActionError::NotPending);
        }
        if record.action.invocation.target_workspace_id != invocation.target_workspace_id
            || record.action.invocation.request_id != invocation.request_id
        {
            return Err(ActionError::InvocationMismatch);
        }
        if record.action.expires_at < Utc::now().to_rfc3339() {
            record.action.status = PendingActionStatus::Expired;
            return Err(ActionError::Expired);
        }
        // Claim the action before the terminal call so two concurrent UI
        // confirmations cannot execute the same PTY operation twice.
        record.action.status = PendingActionStatus::Confirmed;
        Ok(record.clone())
    }

    pub fn finish(&self, action_id: &str, status: PendingActionStatus) -> Option<PendingAction> {
        self.actions.lock().ok().and_then(|mut actions| {
            let record = actions.get_mut(action_id)?;
            record.action.status = status;
            Some(record.action.clone())
        })
    }

    pub fn record(&self, action_id: &str) -> Option<PendingActionRecord> {
        self.actions
            .lock()
            .ok()
            .and_then(|actions| actions.get(action_id).cloned())
    }

    pub fn update_agent_send(
        &self,
        action_id: &str,
        invocation: &InvocationBinding,
        text: &str,
    ) -> Result<PendingAction, ActionError> {
        let normalized = validate_agent_text(text).map_err(|_| ActionError::PayloadInvalid)?;
        let Ok(mut actions) = self.actions.lock() else {
            return Err(ActionError::NotFound);
        };
        let Some(record) = actions.get_mut(action_id) else {
            return Err(ActionError::NotFound);
        };
        if record.action.status != PendingActionStatus::Pending {
            return Err(ActionError::NotPending);
        }
        if record.action.operation != "agent.send"
            || record.action.invocation.target_workspace_id != invocation.target_workspace_id
            || record.action.invocation.request_id != invocation.request_id
        {
            return Err(ActionError::InvocationMismatch);
        }
        if record.action.expires_at < Utc::now().to_rfc3339() {
            record.action.status = PendingActionStatus::Expired;
            return Err(ActionError::Expired);
        }
        record.payload = serde_json::json!({"text": normalized});
        record.action.preview = format!("Scrivere nel terminale: {}", preview_text(&normalized));
        record.action.editable_text = Some(normalized);
        Ok(record.action.clone())
    }
}

/// Normalize a model/user agent prompt without accepting terminal protocol
/// bytes. PTY framing is generated only after confirmation by the backend.
pub fn validate_agent_text(text: &str) -> Result<String, ActionError> {
    if text.trim().is_empty() || text.len() > MAX_ACTION_TEXT_BYTES {
        return Err(ActionError::PayloadInvalid);
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.len() > MAX_ACTION_TEXT_BYTES
        || normalized.bytes().any(|byte| {
            byte == 0
                || byte == 0x1b
                || byte == 0x7f
                || (byte < 0x20 && byte != b'\n' && byte != b'\t')
        })
        || normalized
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(ActionError::PayloadInvalid);
    }
    Ok(normalized)
}

pub fn prompt_bytes(text: &str) -> Result<Vec<u8>, ActionError> {
    let normalized = validate_agent_text(text)?;
    if normalized.contains('\n') {
        let mut bytes = Vec::with_capacity(normalized.len() + 16);
        bytes.extend_from_slice(b"\x1b[200~");
        bytes.extend_from_slice(normalized.as_bytes());
        bytes.extend_from_slice(b"\x1b[201~\r");
        Ok(bytes)
    } else {
        let mut bytes = normalized.into_bytes();
        bytes.push(b'\r');
        Ok(bytes)
    }
}

fn preview_text(text: &str) -> String {
    let value = text.replace('\n', "↵");
    let mut end = value.len().min(240);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn prune_actions(actions: &mut HashMap<String, PendingActionRecord>) {
    if actions.len() <= MAX_PENDING_ACTIONS {
        return;
    }
    let mut candidates = actions
        .values()
        .filter(|record| record.action.status != PendingActionStatus::Pending)
        .map(|record| (record.action.created_at.clone(), record.action.id.clone()))
        .collect::<Vec<_>>();
    candidates.sort();
    let mut remove_count = actions.len().saturating_sub(MAX_PENDING_ACTIONS);
    for (_, id) in candidates {
        if remove_count == 0 {
            break;
        }
        actions.remove(&id);
        remove_count -= 1;
    }
    if remove_count == 0 {
        return;
    }
    // A flood of still-pending proposals must not grow the registry without
    // bound. Expire the oldest proposal first so the UI cannot mistake it for
    // an executable action after it has been evicted.
    let mut pending = actions
        .values()
        .filter(|record| record.action.status == PendingActionStatus::Pending)
        .map(|record| (record.action.created_at.clone(), record.action.id.clone()))
        .collect::<Vec<_>>();
    pending.sort();
    for (_, id) in pending.into_iter().take(remove_count) {
        if let Some(record) = actions.get_mut(&id) {
            record.action.status = PendingActionStatus::Expired;
        }
        actions.remove(&id);
    }
}

fn uuid_like_id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        NEXT_ACTION_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::{
        prompt_bytes, validate_agent_text, PendingActionInput, PendingActionRegistry,
        PendingActionStatus, MAX_PENDING_ACTIONS,
    };
    use crate::jarvis::types::InvocationBinding;
    use serde_json::json;

    fn invocation(request_id: &str) -> InvocationBinding {
        InvocationBinding::new(
            request_id,
            "workspace-a",
            Some("terminal-a".to_string()),
            None,
            "2026-08-07T00:00:00Z",
        )
    }

    #[test]
    fn confirmation_claim_is_bound_and_single_use() {
        let registry = PendingActionRegistry::default();
        let action = registry.create(PendingActionInput {
            operation: "terminal.write".to_string(),
            description: "test".to_string(),
            preview: "echo test".to_string(),
            editable_text: None,
            invocation: invocation("request-a"),
            terminal_id: Some("terminal-a".to_string()),
            generation: Some(3),
            provider: Some("codex".to_string()),
            payload: json!({"text":"echo test"}),
        });

        let claimed = registry
            .take_for_confirmation(&action.id, &invocation("request-a"))
            .expect("matching invocation can claim the action");
        assert_eq!(claimed.action.status, PendingActionStatus::Confirmed);
        assert!(registry
            .take_for_confirmation(&action.id, &invocation("request-a"))
            .is_err());
        assert!(registry
            .take_for_confirmation(&action.id, &invocation("request-b"))
            .is_err());
    }

    #[test]
    fn pending_action_registry_does_not_grow_past_its_bound() {
        let registry = PendingActionRegistry::default();
        for index in 0..(MAX_PENDING_ACTIONS + 8) {
            registry.create(PendingActionInput {
                operation: "terminal.write".to_string(),
                description: format!("test-{index}"),
                preview: "echo test".to_string(),
                editable_text: None,
                invocation: invocation(&format!("request-{index}")),
                terminal_id: Some("terminal-a".to_string()),
                generation: Some(3),
                provider: Some("codex".to_string()),
                payload: json!({"text":"echo test"}),
            });
        }
        assert!(registry.list().len() <= MAX_PENDING_ACTIONS);
    }

    #[test]
    fn agent_text_rejects_terminal_controls_and_normalizes_multiline_input() {
        assert!(validate_agent_text("nul\0").is_err());
        assert!(validate_agent_text("escape\x1b").is_err());
        assert!(validate_agent_text("control\u{0007}").is_err());
        assert_eq!(
            validate_agent_text("one\r\ntwo\rtab\t").unwrap(),
            "one\ntwo\ntab\t"
        );
    }

    #[test]
    fn backend_generates_one_enter_and_bracketed_paste_only_for_multiline() {
        assert_eq!(prompt_bytes("hello").unwrap(), b"hello\r");
        assert_eq!(
            prompt_bytes("one\ntwo").unwrap(),
            b"\x1b[200~one\ntwo\x1b[201~\r"
        );
    }

    #[test]
    fn pending_agent_send_can_be_updated_without_changing_target_or_operation() {
        let registry = PendingActionRegistry::default();
        let action = registry.create(PendingActionInput {
            operation: "agent.send".to_string(),
            description: "send".to_string(),
            preview: "old".to_string(),
            editable_text: Some("old".to_string()),
            invocation: invocation("request-a"),
            terminal_id: Some("terminal-a".to_string()),
            generation: Some(3),
            provider: Some("codex".to_string()),
            payload: json!({"text":"old"}),
        });
        let updated = registry
            .update_agent_send(&action.id, &invocation("request-a"), "new\r\ntext")
            .unwrap();
        assert_eq!(updated.operation, "agent.send");
        assert_eq!(updated.terminal_id.as_deref(), Some("terminal-a"));
        assert_eq!(updated.generation, Some(3));
        assert_eq!(
            registry.record(&action.id).unwrap().payload["text"],
            "new\ntext"
        );
    }
}
