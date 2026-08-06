use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_REQUESTS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRequestError {
    AlreadyRunning,
    RegistryFull,
    NotFound,
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

    pub fn is_cancelled(&self, request_id: &str) -> bool {
        self.requests
            .lock()
            .ok()
            .and_then(|requests| {
                requests
                    .get(request_id)
                    .map(|record| record.cancellation.is_cancelled())
            })
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatRequestError, ChatRequestRegistry};

    #[test]
    fn requests_are_isolated_by_workspace_and_cancel_is_single_request() {
        let registry = ChatRequestRegistry::default();
        let a = registry.start("a", "workspace-a").unwrap();
        let b = registry.start("b", "workspace-b").unwrap();
        assert!(registry.start("a2", "workspace-a").is_err());
        assert!(registry.cancel("a").is_ok());
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
        registry.finish("a");
        assert_eq!(registry.status("a"), Err(ChatRequestError::NotFound));
        assert!(registry.status("b").is_ok());
    }
}
