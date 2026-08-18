//! Typed conversational plans and their workspace-scoped continuation state.
//!
//! This module is deliberately independent from PTY dispatch and target
//! resolution. Callers only need the plan contract and the small state store;
//! the operational implementation remains behind `control.rs`.

use crate::jarvis::actions::validate_agent_text;
use crate::jarvis::runtime_detector::normalize_provider;
use crate::jarvis::types::AgentAssignmentBinding;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

pub const MAX_PLAN_OPERATIONS: usize = 8;
pub const MAX_PLAN_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_PENDING_CONVERSATIONS: usize = 32;
pub const PENDING_CONVERSATION_TTL: Duration = Duration::from_secs(10 * 60);

/// Provider alias resolution for plan execution. Speech transcription often
/// turns the short name for Pi into a single `p`; normalize it before the
/// planner's provider allowlist is applied.
pub(super) fn normalize_plan_provider(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "p" | "pi" | "agente p" | "agente pi" | "agent p" | "agent pi" => Some("pi".to_string()),
        other => normalize_provider(other),
    }
}

/// JSON input schema shared by the legacy and dynamic conversational tools.
pub(crate) fn conversational_plan_schema() -> serde_json::Value {
    serde_json::json!({
        "type":"object",
        "properties": {
            "operations": {
                "type":"array",
                "minItems":1,
                "maxItems":8,
                "items": {
                    "type":"object",
                    "properties": {
                        "operation": {"type":"string","enum":["respond","clarify","agent_report","agent_send","agent_open","agent_handoff","agent_abort","terminal_close","terminal_restart","draft_prompt"]},
                        "provider": {"type":"string","enum":["codex","opencode","pi","freebuff","claude","claudex"]},
                        "target": {"type":"string","maxLength":4096},
                        "source": {"type":"string","maxLength":4096},
                        "destination": {"type":"string","maxLength":4096},
                        "prompt": {"type":"string","maxLength":16384},
                        "confirmed": {"type":"boolean"},
                        "allowBusy": {"type":"boolean"},
                        "followUp": {"type":"boolean","description":"True only when the user explicitly asks to continue or check an existing assignment; reuse its exact binding and do not ask again just because the agent is busy."}
                    },
                    "required":["operation"],
                    "additionalProperties":false
                }
            },
            "response": {"type":"string","maxLength":4096}
        },
        "required":["operations"],
        "additionalProperties":false
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanOperation {
    Respond,
    Clarify,
    AgentReport,
    AgentSend,
    AgentOpen,
    AgentHandoff,
    AgentAbort,
    TerminalClose,
    TerminalRestart,
    DraftPrompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStep {
    pub operation: PlanOperation,
    #[serde(default)]
    pub provider: Option<String>,
    /// A semantic query, never a shell command. It can mention a provider,
    /// read-only terminal title, task or result topic.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
    /// Explicit conversational choice to append work to a known busy session.
    /// This is never sufficient by itself: the pending clarification and the
    /// current terminal generation must also match.
    #[serde(default)]
    pub allow_busy: bool,
    /// Explicitly continues an existing assignment. The backend accepts this
    /// only with the exact previous assignment binding; it is not a shortcut
    /// for sending a new task to an arbitrary busy agent.
    #[serde(default)]
    pub follow_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationalPlan {
    pub operations: Vec<ConversationStep>,
    #[serde(default)]
    pub response: Option<String>,
}

impl ConversationalPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.operations.is_empty() || self.operations.len() > MAX_PLAN_OPERATIONS {
            return Err("il piano deve contenere da una a otto operazioni".to_string());
        }
        if let Some(response) = &self.response {
            validate_plan_text(response)?;
        }
        for step in &self.operations {
            if let Some(provider) = &step.provider {
                normalize_plan_provider(provider)
                    .ok_or_else(|| format!("provider non supportato: {provider}"))?;
            }
            for value in [&step.target, &step.source, &step.destination, &step.prompt] {
                if let Some(value) = value {
                    validate_plan_text(value)?;
                }
            }
            match step.operation {
                // A continuation turn may intentionally omit a prompt because
                // the backend restores it from the exact pending intent. A
                // fresh send/handoff with no prompt still fails at execution.
                PlanOperation::AgentSend | PlanOperation::AgentHandoff => {
                    if let Some(prompt) = &step.prompt {
                        validate_agent_text(prompt)
                            .map_err(|_| "prompt agente non valido".to_string())?;
                    }
                }
                PlanOperation::AgentOpen => {
                    if let Some(prompt) = &step.prompt {
                        validate_agent_text(prompt)
                            .map_err(|_| "prompt iniziale non valido".to_string())?;
                    }
                }
                PlanOperation::DraftPrompt => {
                    validate_agent_text(step.prompt.as_deref().unwrap_or_default())
                        .map_err(|_| "draft non valido".to_string())?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

pub(super) fn validate_plan_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_PLAN_TEXT_BYTES || value.contains('\0') {
        return Err("testo del piano oltre il limite".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingConversationKind {
    Clarification,
    Confirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingConversationalIntent {
    pub workspace_id: String,
    pub kind: PendingConversationKind,
    pub question: String,
    pub operation: PlanOperation,
    pub terminal_id: Option<String>,
    pub generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<AgentAssignmentBinding>,
    pub created_at: String,
    pub expires_at: String,
    pub plan: ConversationalPlan,
}

#[derive(Default)]
pub struct ConversationalControlState {
    pending: Mutex<HashMap<String, PendingConversationalIntent>>,
    last_assignments: Mutex<HashMap<String, AgentAssignmentBinding>>,
    confirmation_bindings: Mutex<HashMap<String, Vec<AgentAssignmentBinding>>>,
}

impl ConversationalControlState {
    pub fn pending(&self, workspace_id: &str) -> Option<PendingConversationalIntent> {
        let mut pending = self.pending.lock().ok()?;
        let value = pending.get(workspace_id).cloned()?;
        if value.expires_at < super::now() {
            pending.remove(workspace_id);
            if let Ok(mut bindings) = self.confirmation_bindings.lock() {
                bindings.remove(workspace_id);
            }
            return None;
        }
        Some(value)
    }

    pub fn put(&self, intent: PendingConversationalIntent) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Ok(mut bindings) = self.confirmation_bindings.lock() {
                bindings.remove(&intent.workspace_id);
            }
            pending.insert(intent.workspace_id.clone(), intent);
            while pending.len() > MAX_PENDING_CONVERSATIONS {
                if let Some(key) = pending
                    .values()
                    .min_by(|left, right| left.created_at.cmp(&right.created_at))
                    .map(|item| item.workspace_id.clone())
                {
                    pending.remove(&key);
                } else {
                    break;
                }
            }
        }
    }

    pub fn clear(&self, workspace_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(workspace_id);
        }
        if let Ok(mut bindings) = self.confirmation_bindings.lock() {
            bindings.remove(workspace_id);
        }
    }

    pub fn set_confirmation_bindings(
        &self,
        workspace_id: &str,
        bindings: Vec<AgentAssignmentBinding>,
    ) {
        if let Ok(mut confirmation_bindings) = self.confirmation_bindings.lock() {
            confirmation_bindings.insert(workspace_id.to_string(), bindings);
        }
    }

    pub fn confirmation_bindings(&self, workspace_id: &str) -> Option<Vec<AgentAssignmentBinding>> {
        self.confirmation_bindings
            .lock()
            .ok()
            .and_then(|bindings| bindings.get(workspace_id).cloned())
    }

    pub fn replace_plan(&self, workspace_id: &str, operations: Vec<ConversationStep>) {
        if operations.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(intent) = pending.get_mut(workspace_id) {
                intent.plan.operations = operations;
            }
        }
    }

    pub fn record_assignment(&self, workspace_id: &str, binding: AgentAssignmentBinding) {
        if let Ok(mut assignments) = self.last_assignments.lock() {
            assignments.insert(workspace_id.to_string(), binding);
        }
    }

    pub fn last_assignment(&self, workspace_id: &str) -> Option<AgentAssignmentBinding> {
        self.last_assignments
            .lock()
            .ok()
            .and_then(|assignments| assignments.get(workspace_id).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response_step() -> ConversationStep {
        ConversationStep {
            operation: PlanOperation::Respond,
            provider: None,
            target: None,
            source: None,
            destination: None,
            prompt: Some("ok".to_string()),
            confirmed: false,
            allow_busy: false,
            follow_up: false,
        }
    }

    #[test]
    fn plan_validation_rejects_empty_oversized_and_control_text() {
        assert!(ConversationalPlan {
            operations: Vec::new(),
            response: None,
        }
        .validate()
        .is_err());

        let too_many = vec![response_step(); MAX_PLAN_OPERATIONS + 1];
        assert!(ConversationalPlan {
            operations: too_many,
            response: None,
        }
        .validate()
        .is_err());

        assert!(ConversationalPlan {
            operations: vec![response_step()],
            response: Some("x".repeat(MAX_PLAN_TEXT_BYTES + 1)),
        }
        .validate()
        .is_err());
        assert!(validate_plan_text("safe\0text").is_err());
    }

    #[test]
    fn pending_state_expires_and_replaces_only_non_empty_plan_tail() {
        let state = ConversationalControlState::default();
        state.put(PendingConversationalIntent {
            workspace_id: "workspace-a".to_string(),
            kind: PendingConversationKind::Clarification,
            question: "continua?".to_string(),
            operation: PlanOperation::Respond,
            terminal_id: None,
            generation: None,
            binding: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            plan: ConversationalPlan {
                operations: vec![response_step()],
                response: None,
            },
        });

        state.replace_plan("workspace-a", Vec::new());
        assert_eq!(
            state.pending("workspace-a").unwrap().plan.operations.len(),
            1
        );
        state.replace_plan("workspace-a", vec![response_step(), response_step()]);
        assert_eq!(
            state.pending("workspace-a").unwrap().plan.operations.len(),
            2
        );

        state.put(PendingConversationalIntent {
            workspace_id: "expired".to_string(),
            kind: PendingConversationKind::Clarification,
            question: "scaduta".to_string(),
            operation: PlanOperation::Respond,
            terminal_id: None,
            generation: None,
            binding: None,
            created_at: "2020-01-01T00:00:00Z".to_string(),
            expires_at: "2000-01-01T00:00:00Z".to_string(),
            plan: ConversationalPlan {
                operations: vec![response_step()],
                response: None,
            },
        });
        assert!(state.pending("expired").is_none());
    }
}
