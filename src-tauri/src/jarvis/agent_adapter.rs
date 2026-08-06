use crate::jarvis::types::{
    AgentCompletionNotification, AgentMessage, AgentResult, AgentSessionContext, AgentSessionRef,
    AgentState, AgentTurnContext, Provenance,
};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSourceError {
    pub code: String,
    pub message: String,
}

impl AgentSourceError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "agent_source_unavailable".to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentStatusSnapshot {
    pub objective: Option<String>,
    pub state: AgentState,
    pub last_turn: Option<AgentTurnContext>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub provenance: Provenance,
    pub confidence: f32,
    pub warnings: Vec<String>,
}

pub trait AgentContextSource: Send + Sync {
    fn list_sessions(&self, workspace_id: &str) -> Result<Vec<AgentSessionRef>, AgentSourceError>;
    fn get_status(
        &self,
        session: &AgentSessionRef,
    ) -> Result<AgentStatusSnapshot, AgentSourceError>;
    fn get_last_result(
        &self,
        session: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, AgentSourceError>;
    fn get_messages(
        &self,
        session: &AgentSessionRef,
    ) -> Result<Vec<AgentMessage>, AgentSourceError>;
}

#[derive(Default)]
pub struct EmptyAgentContextSource;

impl AgentContextSource for EmptyAgentContextSource {
    fn list_sessions(&self, _workspace_id: &str) -> Result<Vec<AgentSessionRef>, AgentSourceError> {
        Ok(Vec::new())
    }

    fn get_status(
        &self,
        _session: &AgentSessionRef,
    ) -> Result<AgentStatusSnapshot, AgentSourceError> {
        Err(AgentSourceError::unavailable(
            "no live agent source configured",
        ))
    }

    fn get_last_result(
        &self,
        _session: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, AgentSourceError> {
        Err(AgentSourceError::unavailable(
            "no live agent source configured",
        ))
    }

    fn get_messages(
        &self,
        _session: &AgentSessionRef,
    ) -> Result<Vec<AgentMessage>, AgentSourceError> {
        Err(AgentSourceError::unavailable(
            "no live agent source configured",
        ))
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct FakeAgentSessionFixture {
    pub reference: AgentSessionRef,
    pub objective: Option<String>,
    pub state: AgentState,
    pub turns: Vec<AgentTurnContext>,
    pub last_result: Option<AgentResult>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub messages: Vec<AgentMessage>,
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct FakeAgentContextSource {
    sessions: Arc<Mutex<HashMap<(String, String), FakeAgentSessionFixture>>>,
}

#[cfg(test)]
impl FakeAgentContextSource {
    pub fn insert(&self, fixture: FakeAgentSessionFixture) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let key = (
                fixture.reference.workspace_id.clone(),
                fixture.reference.agent_session_id.clone(),
            );
            sessions.insert(key, fixture);
        }
    }

    fn find(
        &self,
        reference: &AgentSessionRef,
    ) -> Result<FakeAgentSessionFixture, AgentSourceError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AgentSourceError::unavailable("fake source lock unavailable"))?;
        let key = (
            reference.workspace_id.clone(),
            reference.agent_session_id.clone(),
        );
        let fixture = sessions
            .get(&key)
            .cloned()
            .ok_or_else(|| AgentSourceError {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
            })?;
        Ok(fixture)
    }
}

#[cfg(test)]
impl AgentContextSource for FakeAgentContextSource {
    fn list_sessions(&self, workspace_id: &str) -> Result<Vec<AgentSessionRef>, AgentSourceError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AgentSourceError::unavailable("fake source lock unavailable"))?;
        let mut result = sessions
            .values()
            .filter(|fixture| fixture.reference.workspace_id == workspace_id)
            .map(|fixture| fixture.reference.clone())
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.agent_session_id.cmp(&right.agent_session_id));
        Ok(result)
    }

    fn get_status(
        &self,
        session: &AgentSessionRef,
    ) -> Result<AgentStatusSnapshot, AgentSourceError> {
        let fixture = self.find(session)?;
        Ok(AgentStatusSnapshot {
            objective: fixture.objective,
            state: fixture.state,
            last_turn: fixture.turns.last().cloned(),
            completion_notification: fixture.completion_notification,
            provenance: Provenance::untrusted("fake-agent", "2026-08-06T00:00:00Z"),
            confidence: 1.0,
            warnings: Vec::new(),
        })
    }

    fn get_last_result(
        &self,
        session: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, AgentSourceError> {
        Ok(self.find(session)?.last_result)
    }

    fn get_messages(
        &self,
        session: &AgentSessionRef,
    ) -> Result<Vec<AgentMessage>, AgentSourceError> {
        Ok(self.find(session)?.messages)
    }
}

pub fn context_from_status(
    reference: AgentSessionRef,
    status: AgentStatusSnapshot,
) -> AgentSessionContext {
    AgentSessionContext {
        reference,
        objective: status.objective,
        state: status.state,
        last_turn: status.last_turn,
        last_result: None,
        completion_notification: status.completion_notification,
        messages: None,
        provenance: status.provenance,
        confidence: status.confidence,
        warnings: status.warnings,
    }
}
