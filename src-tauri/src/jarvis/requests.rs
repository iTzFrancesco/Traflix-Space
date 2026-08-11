use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_REQUESTS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRequestError {
    AlreadyRunning,
    RegistryFull,
    NotFound,
    #[cfg(test)]
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRequestStatus {
    Running,
    CancellationRequested,
}

#[derive(Debug, Clone)]
struct ChatRequestRecord {
    workspace_id: String,
    status: ChatRequestStatus,
    cancellation: CancellationToken,
}

#[derive(Default)]
pub struct ChatRequestRegistry {
    requests: Mutex<HashMap<String, ChatRequestRecord>>,
}

impl ChatRequestRegistry {
    pub fn start(
        &self,
        request_id: &str,
        workspace_id: &str,
    ) -> Result<CancellationToken, ChatRequestError> {
        let Ok(mut requests) = self.requests.lock() else {
            return Err(ChatRequestError::RegistryFull);
        };
        if requests
            .values()
            .any(|record| record.workspace_id == workspace_id)
        {
            return Err(ChatRequestError::AlreadyRunning);
        }
        if requests.len() >= MAX_ACTIVE_REQUESTS {
            return Err(ChatRequestError::RegistryFull);
        }
        let cancellation = CancellationToken::new();
        requests.insert(
            request_id.to_string(),
            ChatRequestRecord {
                workspace_id: workspace_id.to_string(),
                status: ChatRequestStatus::Running,
                cancellation: cancellation.clone(),
            },
        );
        Ok(cancellation)
    }

    pub fn cancel(&self, request_id: &str) -> Result<ChatRequestStatus, ChatRequestError> {
        let Ok(mut requests) = self.requests.lock() else {
            return Err(ChatRequestError::NotFound);
        };
        let Some(record) = requests.get_mut(request_id) else {
            return Err(ChatRequestError::NotFound);
        };
        record.cancellation.cancel();
        record.status = ChatRequestStatus::CancellationRequested;
        Ok(record.status)
    }

    /// Spec §18: `jarvis_cancel_chat` also has to interrupt the active Codex
    /// turn of the workspace owning the request; the record keeps the
    /// workspace binding so the cancel path can reach the thread registry.
    pub fn workspace_id_of(&self, request_id: &str) -> Option<String> {
        self.requests
            .lock()
            .ok()?
            .get(request_id)
            .map(|record| record.workspace_id.clone())
    }

    /// Linearize a tool proposal with cancellation. The request mutex is held
    /// while `operation` runs, so cancellation either wins before the action
    /// is created or is ordered after it and can discard that action before
    /// the cancel IPC returns.
    #[cfg(test)]
    pub fn with_active<T, F>(&self, request_id: &str, operation: F) -> Result<T, ChatRequestError>
    where
        F: FnOnce() -> T,
    {
        let Ok(requests) = self.requests.lock() else {
            return Err(ChatRequestError::NotFound);
        };
        let Some(record) = requests.get(request_id) else {
            return Err(ChatRequestError::NotFound);
        };
        if record.cancellation.is_cancelled() {
            return Err(ChatRequestError::Cancelled);
        }
        Ok(operation())
    }

    pub fn status(&self, request_id: &str) -> Result<ChatRequestStatus, ChatRequestError> {
        self.requests
            .lock()
            .ok()
            .and_then(|requests| requests.get(request_id).map(|record| record.status))
            .ok_or(ChatRequestError::NotFound)
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatRequestError, ChatRequestRegistry};
    use crate::jarvis::actions::{PendingActionInput, PendingActionRegistry};
    use crate::jarvis::types::InvocationBinding;
    use serde_json::json;

    #[test]
    fn workspace_id_of_resolves_the_owning_workspace_until_cancel() {
        let registry = ChatRequestRegistry::default();
        registry.start("r1", "workspace-x").unwrap();
        assert_eq!(
            registry.workspace_id_of("r1"),
            Some("workspace-x".to_string())
        );
        // Unknown requests never resolve — cancel can't interrupt a foreign turn.
        assert_eq!(registry.workspace_id_of("missing"), None);
        // The binding survives until the record is removed (cancel keeps it
        // so the interrupt path can still find the turn).
        registry.cancel("r1").unwrap();
        assert_eq!(
            registry.workspace_id_of("r1"),
            Some("workspace-x".to_string())
        );
        registry.finish("r1");
        assert_eq!(registry.workspace_id_of("r1"), None);
    }

    #[test]
    fn requests_are_isolated_by_workspace_and_cancel_is_single_request() {
        let registry = ChatRequestRegistry::default();
        registry.start("a", "workspace-a").unwrap();
        registry.start("b", "workspace-b").unwrap();
        assert!(registry.start("a2", "workspace-a").is_err());
        assert!(registry.cancel("a").is_ok());
        assert_eq!(
            registry.status("a"),
            Ok(super::ChatRequestStatus::CancellationRequested)
        );
        assert_eq!(registry.status("b"), Ok(super::ChatRequestStatus::Running));
        registry.finish("a");
        assert_eq!(registry.status("a"), Err(ChatRequestError::NotFound));
        assert!(registry.status("b").is_ok());
    }

    #[test]
    fn cancelled_request_cannot_enter_the_action_creation_gate() {
        let registry = ChatRequestRegistry::default();
        let actions = PendingActionRegistry::default();
        registry.start("request-a", "workspace-a").unwrap();
        registry.cancel("request-a").unwrap();
        let result = registry.with_active("request-a", || {
            actions.create(PendingActionInput {
                operation: "agent.send".to_string(),
                description: "send".to_string(),
                preview: "old".to_string(),
                editable_text: Some("old".to_string()),
                invocation: InvocationBinding::new(
                    "request-a",
                    "workspace-a",
                    Some("terminal-a".to_string()),
                    None,
                    "2026-08-07T00:00:00Z",
                ),
                terminal_id: Some("terminal-a".to_string()),
                generation: Some(1),
                provider: Some("codex".to_string()),
                payload: json!({"text":"old"}),
            })
        });
        assert!(matches!(result, Err(ChatRequestError::Cancelled)));
        assert!(actions.list().is_empty());
    }
}
