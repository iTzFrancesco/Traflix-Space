use crate::jarvis::agent_registry::AgentSessionRegistry;
use crate::jarvis::types::{
    AgentActivityEvent, AgentCompletionNotification, AgentMessage, AgentResult,
    AgentSessionContext, AgentSessionRef, AgentState, AgentTaskContext, AgentTurnContext,
    Provenance,
};
#[cfg(test)]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

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

    pub fn messages_unavailable() -> Self {
        Self {
            code: "agent_messages_unavailable".to_string(),
            message: "structured agent messages unavailable for terminal source".to_string(),
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
    pub current_task: Option<AgentTaskContext>,
    pub last_activity_at: Option<String>,
    pub activity_timeline: Vec<AgentActivityEvent>,
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
    fn get_activity(
        &self,
        session: &AgentSessionRef,
        limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, AgentSourceError>;
}

#[derive(Clone)]
pub struct LiveAgentContextSource {
    registry: Arc<AgentSessionRegistry>,
}

impl LiveAgentContextSource {
    pub fn new(registry: Arc<AgentSessionRegistry>) -> Self {
        Self { registry }
    }
}

impl AgentContextSource for LiveAgentContextSource {
    fn list_sessions(&self, workspace_id: &str) -> Result<Vec<AgentSessionRef>, AgentSourceError> {
        self.registry.list_sessions(workspace_id)
    }

    fn get_status(
        &self,
        session: &AgentSessionRef,
    ) -> Result<AgentStatusSnapshot, AgentSourceError> {
        let status = self.registry.status(session)?;
        Ok(AgentStatusSnapshot {
            objective: status.objective,
            state: status.state,
            last_turn: status.last_turn,
            completion_notification: status.completion_notification,
            provenance: status.provenance,
            confidence: status.confidence,
            warnings: status.warnings,
            current_task: status.current_task,
            last_activity_at: status.last_activity_at,
            activity_timeline: status.activity_timeline,
        })
    }

    fn get_last_result(
        &self,
        session: &AgentSessionRef,
    ) -> Result<Option<AgentResult>, AgentSourceError> {
        self.registry.last_result(session)
    }

    fn get_messages(
        &self,
        _session: &AgentSessionRef,
    ) -> Result<Vec<AgentMessage>, AgentSourceError> {
        Err(AgentSourceError::messages_unavailable())
    }

    fn get_activity(
        &self,
        session: &AgentSessionRef,
        limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, AgentSourceError> {
        self.registry.activity(session, limit)
    }
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

    fn get_activity(
        &self,
        _session: &AgentSessionRef,
        _limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, AgentSourceError> {
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
            current_task: None,
            last_activity_at: None,
            activity_timeline: Vec::new(),
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

    fn get_activity(
        &self,
        _session: &AgentSessionRef,
        _limit: usize,
    ) -> Result<Vec<AgentActivityEvent>, AgentSourceError> {
        Err(AgentSourceError::unavailable(
            "fake source does not expose activity",
        ))
    }
}

pub fn context_from_status(
    reference: AgentSessionRef,
    status: AgentStatusSnapshot,
) -> AgentSessionContext {
    AgentSessionContext {
        configured_agent_id: reference.configured_agent_id.clone(),
        observed_provider: reference.observed_provider.clone(),
        resolved_provider: reference.resolved_provider.clone(),
        detection_source: reference.detection_source.clone(),
        detection_confidence: reference.detection_confidence,
        identity_warnings: reference.identity_warnings.clone(),
        identity_needs_confirmation: reference.identity_needs_confirmation,
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
        current_task: status.current_task,
        last_activity_at: status.last_activity_at,
    }
}
