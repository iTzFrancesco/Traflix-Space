use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationIndexEntry {
    pub relative_path: String,
    pub modified_at: String,
    pub content_hash: String,
    pub truncated: bool,
    pub untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationSummary {
    pub workspace_id: String,
    pub revision: String,
    pub cache_status: CacheStatus,
    pub document_count: usize,
    pub omitted_count: usize,
    pub truncated_count: usize,
    pub warning_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentationExcerpt {
    pub relative_path: String,
    pub content_hash: String,
    pub content: String,
    pub truncated: bool,
    pub untrusted: bool,
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
    pub configured_agent_id: Option<String>,
    pub observed_provider: Option<String>,
    pub resolved_provider: String,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
    pub generation: u64,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRef {
    pub agent_session_id: String,
    /// Backwards-compatible alias for the provider shown by older clients.
    pub provider: String,
    pub configured_agent_id: Option<String>,
    pub observed_provider: Option<String>,
    pub resolved_provider: String,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
    pub identity_needs_confirmation: bool,
    pub workspace_id: String,
    pub terminal_id: Option<String>,
    pub generation: u64,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Compact operational task enrichment for `agent.list` and friends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_task: Option<AgentTaskContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
}

/// Who originated an agent task or activity. Jarvis-sent prompts are recorded
/// with `Jarvis` only after the backend has proven the PTY write succeeded.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentInteractionSource {
    User,
    Jarvis,
    System,
}

/// The current operational task of an agent session, as reconstructed from the
/// shared visible PTY. Never persisted, bounded to `MAX_TASK_TEXT_BYTES`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskContext {
    pub text: String,
    pub source: AgentInteractionSource,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub confidence: f32,
    pub untrusted: bool,
}

/// Semantic activity kinds of an agent session. These are not raw scrollback
/// lines: they are bounded, deduplicated interpretations of session signals.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentActivityKind {
    PromptSubmitted,
    Working,
    CompletionObserved,
    ResultAvailable,
    Interrupted,
    Exited,
}

/// One bounded event of the semantic activity timeline of an agent session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivityEvent {
    pub id: String,
    pub kind: AgentActivityKind,
    pub source: AgentInteractionSource,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_excerpt: Option<String>,
    pub confidence: f32,
    pub untrusted: bool,
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
    pub configured_agent_id: Option<String>,
    pub observed_provider: Option<String>,
    pub resolved_provider: String,
    pub detection_source: String,
    pub detection_confidence: f32,
    pub identity_warnings: Vec<String>,
    pub identity_needs_confirmation: bool,
    pub objective: Option<String>,
    pub state: AgentState,
    pub last_turn: Option<AgentTurnContext>,
    pub last_result: Option<AgentResult>,
    pub completion_notification: Option<AgentCompletionNotification>,
    pub messages: Option<Vec<AgentMessage>>,
    pub provenance: Provenance,
    pub confidence: f32,
    pub warnings: Vec<String>,
    /// Compact task enrichment mirroring `reference.current_task`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_task: Option<AgentTaskContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
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
pub struct ModelContextViewV1 {
    pub view_version: String,
    pub invocation: InvocationBinding,
    pub documentation_summary: DocumentationSummary,
    pub document_index: Vec<DocumentationIndexEntry>,
    pub documentation_excerpts: Vec<DocumentationExcerpt>,
    pub terminals: Vec<TerminalSummary>,
    pub agent_sessions: Vec<AgentSessionContext>,
    pub requested_depth: RequestedDepth,
    pub provenance: Provenance,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelContextViewError {
    InvalidDocumentPath,
}

impl ContextPackageV1 {
    pub fn to_model_context_view(
        &self,
        requested_document_paths: &[String],
    ) -> Result<ModelContextViewV1, ModelContextViewError> {
        let mut requested_paths = requested_document_paths.to_vec();
        requested_paths.sort();
        requested_paths.dedup();

        let mut documentation_excerpts = Vec::new();
        let mut warnings = self.warnings.clone();
        for relative_path in requested_paths {
            if !is_safe_relative_path(&relative_path) {
                return Err(ModelContextViewError::InvalidDocumentPath);
            }

            if let Some(document) = self
                .documentation
                .documents
                .iter()
                .find(|document| document.relative_path == relative_path)
            {
                let (content, excerpt_truncated) = bounded_excerpt(&document.content, 8 * 1024);
                documentation_excerpts.push(DocumentationExcerpt {
                    relative_path: document.relative_path.clone(),
                    content_hash: document.content_hash.clone(),
                    content,
                    truncated: document.truncated || excerpt_truncated,
                    untrusted: document.untrusted,
                });
            } else {
                warnings.push("requested document excerpt unavailable".to_string());
            }
        }

        let document_index = self
            .documentation
            .documents
            .iter()
            .map(|document| DocumentationIndexEntry {
                relative_path: document.relative_path.clone(),
                modified_at: document.modified_at.clone(),
                content_hash: document.content_hash.clone(),
                truncated: document.truncated,
                untrusted: document.untrusted,
            })
            .collect::<Vec<_>>();
        let truncated_count = document_index
            .iter()
            .filter(|document| document.truncated)
            .count();

        warnings.sort();
        warnings.dedup();
        Ok(ModelContextViewV1 {
            view_version: "1".to_string(),
            invocation: self.invocation.clone(),
            documentation_summary: DocumentationSummary {
                workspace_id: self.documentation.workspace_id.clone(),
                revision: self.documentation.revision.clone(),
                cache_status: self.documentation.cache_status,
                document_count: document_index.len(),
                omitted_count: self.documentation.omitted_documents.len(),
                truncated_count,
                warning_count: self.documentation.warnings.len(),
            },
            document_index,
            documentation_excerpts,
            terminals: self.terminals.clone(),
            agent_sessions: self.agent_sessions.clone(),
            requested_depth: self.requested_depth,
            provenance: Provenance::trusted("context-broker", &self.documentation.generated_at),
            warnings,
        })
    }
}

fn is_safe_relative_path(relative_path: &str) -> bool {
    let path = Path::new(relative_path);
    !relative_path.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn bounded_excerpt(content: &str, max_bytes: usize) -> (String, bool) {
    if content.len() <= max_bytes {
        return (content.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    (content[..end].to_string(), true)
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
