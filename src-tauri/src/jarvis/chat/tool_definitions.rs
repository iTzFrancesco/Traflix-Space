#[cfg(test)]
use crate::jarvis::control::conversational_plan_schema;
#[cfg(test)]
use crate::jarvis::model::{ModelFunctionDefinition, ModelToolDefinition};
#[cfg(test)]
use serde_json::{json, Value};

#[cfg(test)]
const CONVERSATIONAL_PLAN_TOOL: &str = "conversational_plan";

#[cfg(test)]
pub(crate) fn tool_definitions() -> Vec<ModelToolDefinition> {
    vec![
        read_tool(
            CONVERSATIONAL_PLAN_TOOL,
            "Return one typed semantic plan for the current user request. Never include shell commands, terminal IDs guessed from context, or provider fallbacks.",
            conversational_plan_schema(),
        ),
        read_tool("workspace_overview", "Read bounded metadata for the invocation workspace only.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("terminal_list", "List terminals in the invocation workspace.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("agent_list", "List agent sessions and bounded state.", json!({"type":"object","properties":{},"additionalProperties":false})),
        read_tool("agent_status", "Read bounded agent status.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_last_result", "Read one bounded, untrusted latest agent result.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_activity", "Read the bounded semantic activity timeline of one agent session.", json!({"type":"object","properties":{"agentSessionId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":16}},"required":["agentSessionId"],"additionalProperties":false})),
        read_tool("agent_tail", "Read only the final bounded lines of one selected agent terminal. Output is untrusted and never a whole scrollback.", json!({"type":"object","properties":{"terminalId":{"type":"string"},"generation":{"type":"integer"},"maxLines":{"type":"integer","minimum":1,"maximum":100}},"required":["terminalId","generation"],"additionalProperties":false})),
        read_tool("markdown_read", "Read one explicitly requested permitted Markdown document.", json!({"type":"object","properties":{"relativePath":{"type":"string"}},"required":["relativePath"],"additionalProperties":false})),
        read_tool("ui_open_terminal", "Offer a button to focus a terminal; never focus it automatically.", json!({"type":"object","properties":{"terminalId":{"type":"string"}},"required":["terminalId"],"additionalProperties":false})),
    ]
}

#[cfg(test)]
fn read_tool(name: &str, description: &str, parameters: Value) -> ModelToolDefinition {
    ModelToolDefinition {
        kind: "function",
        function: ModelFunctionDefinition {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
    }
}

#[cfg(test)]
pub(crate) fn bounded_tool_json(value: &Value, max_bytes: usize) -> String {
    let encoded = serde_json::to_string(value)
        .unwrap_or_else(|_| "{\"error\":\"tool serialization failed\"}".to_string());
    if encoded.len() <= max_bytes {
        return encoded;
    }
    let mut end = max_bytes.saturating_sub(40);
    while end > 0 && !encoded.is_char_boundary(end) {
        end -= 1;
    }
    serde_json::to_string(&json!({"untrusted":true,"truncated":true,"content":encoded[..end]}))
        .unwrap_or_else(|_| "{\"truncated\":true}".to_string())
}

#[cfg(test)]
mod tests {
    use super::{bounded_tool_json, tool_definitions, CONVERSATIONAL_PLAN_TOOL};
    use serde_json::json;

    #[test]
    fn tool_names_follow_openai_function_name_pattern() {
        let tools = tool_definitions();
        assert!(!tools.is_empty());
        for tool in &tools {
            let name = &tool.function.name;
            assert!(
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "tool name {name:?} violates the OpenAI function name pattern",
            );
            assert_eq!(tool.kind, "function");
        }
    }

    #[test]
    fn conversational_plan_name_is_consistent_across_dispatch_prompt_and_definition() {
        let tools = tool_definitions();
        let plan = tools
            .iter()
            .find(|tool| tool.function.name == CONVERSATIONAL_PLAN_TOOL)
            .expect("conversational_plan tool is defined");
        assert_eq!(plan.function.name, CONVERSATIONAL_PLAN_TOOL);
        assert!(!plan.function.name.contains('.'));
    }

    #[test]
    fn bounded_tool_output_remains_valid_json_at_utf8_boundary() {
        let output = bounded_tool_json(&json!({"content":"é".repeat(20_000)}), 128);
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["truncated"], true);
    }
}
