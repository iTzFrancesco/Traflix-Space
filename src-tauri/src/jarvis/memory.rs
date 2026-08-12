use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const MAX_MESSAGES_PER_WORKSPACE: usize = 48;
pub const MAX_MESSAGES_GLOBAL: usize = 256;
pub const MAX_USER_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_ASSISTANT_MESSAGE_BYTES: usize = 24 * 1024;
pub const MAX_MEMORY_WORKSPACE_BYTES: usize = 128 * 1024;
pub const MAX_MEMORY_GLOBAL_BYTES: usize = 512 * 1024;
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

pub struct ConversationMemory {
    messages: Mutex<HashMap<String, VecDeque<MemoryMessage>>>,
    persistence_path: Option<PathBuf>,
}

impl Default for ConversationMemory {
    fn default() -> Self {
        Self {
            messages: Mutex::new(HashMap::new()),
            persistence_path: None,
        }
    }
}

impl ConversationMemory {
    pub fn persistent(path: PathBuf) -> Self {
        let messages = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let memory = Self {
            messages: Mutex::new(messages),
            persistence_path: Some(path),
        };
        memory.enforce_bounds();
        memory
    }

    pub fn append(
        &self,
        workspace_id: &str,
        role: &str,
        content: String,
        provider: Option<String>,
        untrusted: bool,
    ) -> MemoryMessage {
        self.append_with_id(workspace_id, None, role, content, provider, untrusted)
    }

    pub fn append_with_id(
        &self,
        workspace_id: &str,
        id: Option<String>,
        role: &str,
        content: String,
        provider: Option<String>,
        untrusted: bool,
    ) -> MemoryMessage {
        if let Ok(all) = self.messages.lock() {
            if let Some(existing) = all.get(workspace_id).and_then(|messages| {
                id.as_deref()
                    .and_then(|id| messages.iter().find(|message| message.id == id))
            }) {
                return existing.clone();
            }
        }
        let max_bytes = if role == "user" {
            MAX_USER_MESSAGE_BYTES
        } else {
            MAX_ASSISTANT_MESSAGE_BYTES
        };
        let content = bounded_utf8(&content, max_bytes);
        let message = MemoryMessage {
            id: id.unwrap_or_else(|| format!("jarvis-message:{}", uuid_like_id())),
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
            while history_bytes(history) > MAX_MEMORY_WORKSPACE_BYTES {
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
            while all.values().map(history_bytes).sum::<usize>() > MAX_MEMORY_GLOBAL_BYTES {
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
            self.persist_locked(&all);
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
            self.persist_locked(&all);
        }
    }

    fn enforce_bounds(&self) {
        let Ok(mut all) = self.messages.lock() else {
            return;
        };
        for messages in all.values_mut() {
            while messages.len() > MAX_MESSAGES_PER_WORKSPACE
                || history_bytes(messages) > MAX_MEMORY_WORKSPACE_BYTES
            {
                messages.pop_front();
            }
        }
        all.retain(|_, messages| !messages.is_empty());
        while all.values().map(VecDeque::len).sum::<usize>() > MAX_MESSAGES_GLOBAL
            || all.values().map(history_bytes).sum::<usize>() > MAX_MEMORY_GLOBAL_BYTES
        {
            let Some(workspace_id) = all
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
            if let Some(messages) = all.get_mut(&workspace_id) {
                messages.pop_front();
            }
            all.retain(|_, messages| !messages.is_empty());
        }
    }

    fn persist_locked(&self, all: &HashMap<String, VecDeque<MemoryMessage>>) {
        let Some(path) = self.persistence_path.as_ref() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        if let Ok(bytes) = serde_json::to_vec(all) {
            let Ok(mut temporary) = tempfile::NamedTempFile::new_in(parent) else {
                return;
            };
            if temporary.write_all(&bytes).is_err() || temporary.as_file_mut().sync_all().is_err() {
                return;
            }
            let _ = temporary.persist(path);
        }
    }
}

fn history_bytes(messages: &VecDeque<MemoryMessage>) -> usize {
    messages.iter().map(|message| message.content.len()).sum()
}

fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
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

    #[test]
    fn memory_is_bounded_by_utf8_bytes_and_message_id_is_idempotent() {
        let memory = ConversationMemory::default();
        let message = memory.append_with_id(
            "a",
            Some("stable".into()),
            "user",
            "é".repeat(20_000),
            None,
            false,
        );
        assert!(message.content.len() <= super::MAX_USER_MESSAGE_BYTES);
        let same = memory.append_with_id(
            "a",
            Some("stable".into()),
            "user",
            "different".into(),
            None,
            false,
        );
        assert_eq!(same.content, message.content);
        assert!(
            memory
                .recent("a", 100)
                .iter()
                .map(|value| value.content.len())
                .sum::<usize>()
                <= super::MAX_MEMORY_WORKSPACE_BYTES
        );
    }

    #[test]
    fn clear_removes_only_the_requested_workspace() {
        let memory = ConversationMemory::default();
        memory.append("a", "user", "a".into(), None, false);
        memory.append("b", "user", "b".into(), None, false);
        memory.clear("a");
        assert!(memory.recent("a", 10).is_empty());
        assert_eq!(memory.recent("b", 10)[0].content, "b");
    }

    #[test]
    fn global_memory_byte_bound_evicts_oldest_workspace_messages() {
        let memory = ConversationMemory::default();
        for index in 0..8 {
            memory.append(
                "workspace-a",
                "assistant",
                format!("{index}:{}", "é".repeat(20_000)),
                None,
                false,
            );
            memory.append(
                "workspace-b",
                "assistant",
                format!("{index}:{}", "b".repeat(20_000)),
                None,
                false,
            );
        }
        let total: usize = memory
            .recent("workspace-a", 100)
            .iter()
            .chain(memory.recent("workspace-b", 100).iter())
            .map(|message| message.content.len())
            .sum();
        assert!(total <= super::MAX_MEMORY_GLOBAL_BYTES);
    }

    #[test]
    fn persistent_memory_restores_workspace_history_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("jarvis-memory.json");
        let memory = ConversationMemory::persistent(path.clone());
        memory.append(
            "workspace-a",
            "user",
            "delega la review a Codex".into(),
            None,
            false,
        );
        memory.append(
            "workspace-a",
            "assistant",
            "delegazione inviata".into(),
            None,
            false,
        );
        drop(memory);

        let restored = ConversationMemory::persistent(path);
        assert_eq!(restored.recent("workspace-a", 4).len(), 2);
        assert_eq!(
            restored.recent("workspace-a", 4)[0].content,
            "delega la review a Codex"
        );
    }
}
