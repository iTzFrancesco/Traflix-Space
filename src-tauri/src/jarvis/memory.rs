use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_MESSAGES_PER_WORKSPACE: usize = 48;
const MAX_MESSAGES_GLOBAL: usize = 256;
static NEXT_MESSAGE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub workspace_id: String,
    pub created_at: String,
    pub provider: Option<String>,
    pub untrusted: bool,
}

#[derive(Default)]
pub struct ConversationMemory {
    messages: Mutex<HashMap<String, VecDeque<MemoryMessage>>>,
}

impl ConversationMemory {
    pub fn append(
        &self,
        workspace_id: &str,
        role: &str,
        content: String,
        provider: Option<String>,
        untrusted: bool,
    ) -> MemoryMessage {
        let message = MemoryMessage {
            id: format!("jarvis-message:{}", uuid_like_id()),
            role: role.to_string(),
            content,
            workspace_id: workspace_id.to_string(),
            created_at: Utc::now().to_rfc3339(),
            provider,
            untrusted,
        };
        if let Ok(mut all) = self.messages.lock() {
            let history = all.entry(workspace_id.to_string()).or_default();
            history.push_back(message.clone());
            while history.len() > MAX_MESSAGES_PER_WORKSPACE {
                history.pop_front();
            }
            while all.values().map(VecDeque::len).sum::<usize>() > MAX_MESSAGES_GLOBAL {
                let Some(oldest_workspace) = all
                    .iter()
                    .filter_map(|(id, messages)| {
                        messages
                            .front()
                            .map(|message| (id.clone(), message.created_at.clone()))
                    })
                    .min_by(|left, right| left.1.cmp(&right.1))
                    .map(|(id, _)| id)
                else {
                    break;
                };
                if let Some(messages) = all.get_mut(&oldest_workspace) {
                    messages.pop_front();
                }
                all.retain(|_, messages| !messages.is_empty());
            }
        }
        message
    }

    pub fn recent(&self, workspace_id: &str, limit: usize) -> Vec<MemoryMessage> {
        self.messages
            .lock()
            .ok()
            .and_then(|all| all.get(workspace_id).cloned())
            .map(|messages| {
                messages
                    .into_iter()
                    .rev()
                    .take(limit)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn clear(&self, workspace_id: &str) {
        if let Ok(mut all) = self.messages.lock() {
            all.remove(workspace_id);
        }
    }
}

fn uuid_like_id() -> String {
    // The ID is only a volatile UI key; it deliberately does not include
    // message content or a provider identifier.
    format!(
        "{}-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        NEXT_MESSAGE_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::ConversationMemory;

    #[test]
    fn memory_is_bounded_and_scoped_by_workspace() {
        let memory = ConversationMemory::default();
        for index in 0..60 {
            memory.append("a", "user", format!("{index}"), None, false);
        }
        memory.append("b", "user", "other".to_string(), None, false);
        let a = memory.recent("a", 100);
        assert_eq!(a.len(), 48);
        assert_eq!(
            a.first().map(|message| message.content.as_str()),
            Some("12")
        );
        assert_eq!(memory.recent("b", 10).len(), 1);
    }
}
