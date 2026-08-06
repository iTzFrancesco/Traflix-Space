use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvocationBinding {
    pub request_id: String,
    pub target_workspace_id: String,
    pub target_terminal_id: Option<String>,
    pub target_agent_session_id: Option<String>,
    pub created_at: String,
}

impl InvocationBinding {
    pub fn new(
        request_id: impl Into<String>,
        target_workspace_id: impl Into<String>,
        target_terminal_id: Option<String>,
        target_agent_session_id: Option<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            target_workspace_id: target_workspace_id.into(),
            target_terminal_id,
            target_agent_session_id,
            created_at: created_at.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestedDepth {
    Summary,
    LastResult,
    FullMessages,
}

impl Default for RequestedDepth {
    fn default() -> Self {
        Self::Summary
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CacheStatus {
    Miss,
    Hit,
    Incremental,
    Invalidated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: String,
    pub observed_at: String,
    pub confidence: f32,
    pub untrusted: bool,
}

impl Provenance {
    pub fn trusted(source: impl Into<String>, observed_at: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            observed_at: observed_at.into(),
            confidence: 1.0,
            untrusted: false,
        }
    }

    pub fn untrusted(source: impl Into<String>, observed_at: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            observed_at: observed_at.into(),
            confidence: 1.0,
            untrusted: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationEntry {
    pub relative_path: String,
    pub modified_at: String,
    pub content_hash: String,
    pub content: String,
    pub truncated: bool,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OmittedDocument {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationContext {
    pub workspace_id: String,
    pub workspace_root: String,
    pub generated_at: String,
    pub revision: String,
    pub cache_status: CacheStatus,
    pub documents: Vec<DocumentationEntry>,
    pub omitted_documents: Vec<OmittedDocument>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub terminal_id: String,
    pub workspace_id: String,
    pub shell: String,
    pub cwd: String,
    pub active: bool,
    pub process_alive: bool,
    pub agent_id: Option<String>,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRef {
    pub agent_session_id: String,
    pub provider: String,
    pub workspace_id: String,
    pub terminal_id: Option<String>,
    pub provider_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Starting,
    Working,
    Waiting,
    Completed,
    Failed,
    Aborted,
    Exited,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnContext {
    pub turn_id: Option<String>,
    pub state: AgentState,
    pub objective: Option<String>,
    pub occurred_at: Option<String>,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub content: String,
    pub truncated: bool,
    pub untrusted: bool,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompletionNotification {
    pub event_id: Option<String>,
    pub observed_at: String,
    pub result_available: bool,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub role: String,
    pub content: String,
    pub turn_id: Option<String>,
    pub created_at: String,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionContext {
    #[serde(rename = "ref")]
    pub reference: AgentSessionRef,
    pub objective: Option<String>,
    pub state: AgentState,
    pub last_turn: Option<AgentTurnContext>,
    pub last_result: Option<AgentResult>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub messages: Option<Vec<AgentMessage>>,
    pub provenance: Provenance,
    pub confidence: f32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub terminal_count: usize,
    pub agent_count: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackageV1 {
    pub package_version: String,
    pub invocation: InvocationBinding,
    pub documentation: DocumentationContext,
    pub terminals: Vec<TerminalSummary>,
    pub agent_sessions: Vec<AgentSessionContext>,
    pub requested_depth: RequestedDepth,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolEnvelope<T> {
    pub data: T,
    pub provenance: Provenance,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JarvisErrorEnvelope {
    pub code: String,
    pub message: String,
    pub request_id: Option<String>,
    pub workspace_id: Option<String>,
    pub provenance: Provenance,
}

impl JarvisErrorEnvelope {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        request_id: Option<String>,
        workspace_id: Option<String>,
        observed_at: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            request_id,
            workspace_id,
            provenance: Provenance::trusted("jarvis", observed_at),
        }
    }
}
