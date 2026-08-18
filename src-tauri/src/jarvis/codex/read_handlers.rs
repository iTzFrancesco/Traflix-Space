//! Read-only dynamic tool handlers.
//!
//! The handler owns workspace/generation scoping and bounded projections; the
//! parent service owns request routing, budgets, cancellation, and replies.

use serde_json::{json, Value};
use tauri::Manager;

use super::CodexToolService;
use crate::jarvis::agent_registry::{DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT};
use crate::jarvis::chat::{provider_display_name, read_markdown};
use crate::jarvis::checkpoints::{emit_checkpoint, JarvisActivityStatus};
use crate::jarvis::control::{build_tail, DEFAULT_TAIL_LINES, MAX_TAIL_BYTES};
use crate::jarvis::tools::{attach_terminal_titles, JarvisToolService};
use crate::jarvis::types::{InvocationBinding, RequestedDepth, TerminalSummary};
use crate::jarvis::JarvisState;
use crate::terminal_engine::TerminalManager;
use crate::workspace::registry::WorkspaceConfig;

impl CodexToolService {
    pub(super) async fn dispatch_read_tool(
        &self,
        workspace: &WorkspaceConfig,
        invocation: &InvocationBinding,
        terminals: &[TerminalSummary],
        observed_at: &str,
        legacy_name: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let app = &self.app;
        let workspace_id = &invocation.target_workspace_id;
        let request_id = &invocation.request_id;
        let manager = app.state::<TerminalManager>();
        let jarvis_state = app.state::<JarvisState>();
        let service = JarvisToolService::new(&jarvis_state.broker);

        // Same activity checkpoints as the legacy dispatcher, so the widget
        // keeps showing "Checking agents…"-style phases during tool work.
        let checkpoint = read_tool_checkpoint(legacy_name, input);
        let checkpoint = checkpoint.map(|(phase, label, target)| {
            emit_checkpoint(
                app,
                request_id,
                workspace_id,
                &phase,
                &label,
                JarvisActivityStatus::Running,
                target.clone(),
            );
            (phase, label, target)
        });

        let result = match legacy_name {
            "ui_open_terminal" => {
                let terminal_id = input
                    .get("terminalId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !terminals.iter().any(|terminal| {
                    terminal.terminal_id == terminal_id && terminal.workspace_id == *workspace_id
                }) {
                    Ok(json!({"error":"terminal target is not owned by invocation workspace"}))
                } else {
                    Ok(json!(
                        {"intent":"open_terminal","executed":false}
                    ))
                }
            }
            "terminal_list" => {
                serde_json::to_value(terminals).map_err(|_| "terminal list unavailable".to_string())
            }
            "agent_list" => {
                let envelope = service
                    .agent_snapshot(workspace_id, Some(request_id.clone()), observed_at)
                    .map_err(|err| err.message)?;
                let mut sessions = envelope.data;
                attach_terminal_titles(&mut sessions, terminals);
                serde_json::to_value(sessions).map_err(|_| "agent list unavailable".to_string())
            }
            "agent_status" => {
                let session_id = input
                    .get("agentSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let envelope = service
                    .agent_status(
                        workspace_id,
                        session_id,
                        Some(request_id.clone()),
                        observed_at,
                    )
                    .map_err(|err| err.message)?;
                let mut status = envelope.data;
                attach_terminal_titles(std::slice::from_mut(&mut status), terminals);
                serde_json::to_value(status).map_err(|_| "agent status unavailable".to_string())
            }
            "agent_last_result" => {
                let session_id = input
                    .get("agentSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let envelope = service
                    .agent_last_result(
                        workspace_id,
                        session_id,
                        Some(request_id.clone()),
                        observed_at,
                    )
                    .map_err(|err| err.message)?;
                if envelope.data.is_none() {
                    Ok(json!(
                        {"error":"agent session or result unavailable"}
                    ))
                } else {
                    serde_json::to_value(envelope.data)
                        .map_err(|_| "agent result unavailable".to_string())
                }
            }
            "agent_activity" => {
                let session_id = input
                    .get("agentSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let limit = input
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_ACTIVITY_LIMIT as u64)
                    .min(MAX_ACTIVITY_LIMIT as u64)
                    .max(1) as usize;
                let envelope = service
                    .agent_activity(
                        workspace_id,
                        session_id,
                        limit,
                        Some(request_id.clone()),
                        observed_at,
                    )
                    .map_err(|err| err.message)?;
                serde_json::to_value(envelope.data)
                    .map_err(|_| "agent activity unavailable".to_string())
            }
            "agent_tail" => {
                let terminal_id = input
                    .get("terminalId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let generation = input
                    .get("generation")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let Some(terminal) = terminals.iter().find(|terminal| {
                    terminal.terminal_id == terminal_id
                        && terminal.workspace_id == *workspace_id
                        && terminal.generation == generation
                }) else {
                    return Ok(json!({"error":"terminal generation mismatch"}));
                };
                let max_lines = input
                    .get("maxLines")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_TAIL_LINES as u64) as usize;
                match manager
                    .get_recent_normalized_terminal_text_for_runtime(
                        terminal_id,
                        &terminal.workspace_id,
                        terminal.generation,
                        terminal.process_id,
                        MAX_TAIL_BYTES,
                    )
                    .await
                {
                    Ok(raw) => serde_json::to_value(build_tail(
                        &terminal.workspace_id,
                        terminal_id,
                        generation,
                        &raw.content,
                        max_lines,
                        raw.truncated,
                    ))
                    .map_err(|_| "terminal tail unavailable".to_string()),
                    Err(_) => Ok(json!({"error":"terminal tail unavailable"})),
                }
            }
            "workspace_overview" => {
                // Only this tool needs the bounded documentation index; build
                // it once at Summary depth (no agent last results).
                let context = service
                    .build_context(
                        workspace,
                        invocation.clone(),
                        terminals.to_vec(),
                        RequestedDepth::Summary,
                    )
                    .map_err(|err| err.message)?
                    .to_model_context_view(&[])
                    .map_err(|err| format!("context projection failed: {err:?}"))?;
                Ok(json!({
                    "id": workspace.id,
                    "name": workspace.name,
                    "terminalCount": context.terminals.len(),
                    "agentCount": context.agent_sessions.len(),
                    "documentationSummary": context.documentation_summary,
                    "documentIndex": context.document_index,
                    "documentationPolicy": {
                        "automaticScope": "root *.md + docs/**/*.md",
                        "priority": ["README.md", "AGENTS.md", "AGENT.md", "CONTEXT.md", "docs/**/*.md"],
                        "excludedToolingDirectory": ".agents/",
                        "untrusted": true
                    }
                }))
            }
            "markdown_read" => {
                let path = input
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match read_markdown(app, workspace, invocation.clone(), path.to_string()).await {
                    Ok(value) => {
                        serde_json::to_value(value).map_err(|_| "document unavailable".to_string())
                    }
                    Err(_) => Ok(json!(
                        {"error":"document rejected by context policy"}
                    )),
                }
            }
            other => Err(format!("unknown read-only tool: {other}")),
        };

        if let Some((phase, label, target)) = checkpoint {
            // Keep the legacy label style: agent_status shows the resolved
            // provider display name on the completion checkpoint.
            let label = if legacy_name == "agent_status" {
                result
                    .as_ref()
                    .ok()
                    .and_then(|value| value.get("resolvedProvider"))
                    .and_then(Value::as_str)
                    .map(|provider| format!("Checking {}…", provider_display_name(provider)))
                    .unwrap_or(label)
            } else {
                label
            };
            let failed = result
                .as_ref()
                .map_or(true, |value| value.get("error").is_some());
            emit_checkpoint(
                app,
                request_id,
                workspace_id,
                &phase,
                &label,
                if failed {
                    JarvisActivityStatus::Failed
                } else {
                    JarvisActivityStatus::Done
                },
                target,
            );
        }
        result
    }
}

fn read_tool_checkpoint(
    legacy_name: &str,
    args: &Value,
) -> Option<(String, String, Option<String>)> {
    match legacy_name {
        "agent_list" => Some((
            "checking_agents".to_string(),
            "Checking agents…".to_string(),
            None,
        )),
        "agent_status" => {
            let session_id = args
                .get("agentSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some((
                "checking_agent".to_string(),
                "Checking agent…".to_string(),
                Some(session_id.to_string()),
            ))
        }
        "agent_last_result" => Some((
            "reading_result".to_string(),
            "Reading last result…".to_string(),
            args.get("agentSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "agent_activity" => Some((
            "reading_activity".to_string(),
            "Reading agent timeline…".to_string(),
            args.get("agentSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "agent_tail" => Some((
            "reading_tail".to_string(),
            "Reading terminal tail…".to_string(),
            args.get("terminalId")
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        _ => None,
    }
}
