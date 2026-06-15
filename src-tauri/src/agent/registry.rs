use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub icon: String,
    pub color: String,
    pub requires_api_key: bool,
    pub api_key_env: Option<String>,
}

pub struct AgentRegistry {
    agents: Vec<AgentDefinition>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: vec![
                AgentDefinition {
                    id: "aider".into(),
                    name: "Aider".into(),
                    description: "AI pair programming nel terminale".into(),
                    command: "aider".into(),
                    args: vec!["--model".into(), "claude-3-5-sonnet-20241022".into()],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#e85d04".into(),
                    requires_api_key: true,
                    api_key_env: Some("ANTHROPIC_API_KEY".into()),
                },
                AgentDefinition {
                    id: "opencode".into(),
                    name: "OpenCode".into(),
                    description: "Agente AI con TUI avanzata".into(),
                    command: "opencode".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Terminal".into(),
                    color: "#22c55e".into(),
                    requires_api_key: true,
                    api_key_env: Some("OPENAI_API_KEY".into()),
                },
                AgentDefinition {
                    id: "claude".into(),
                    name: "Claude".into(),
                    description: "Agente AI Claude di Anthropic".into(),
                    command: "claude".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "MessageSquare".into(),
                    color: "#d97757".into(),
                    requires_api_key: true,
                    api_key_env: Some("ANTHROPIC_API_KEY".into()),
                },
                AgentDefinition {
                    id: "gemini".into(),
                    name: "Gemini".into(),
                    description: "Agente AI Google Gemini".into(),
                    command: "gemini".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#4285F4".into(),
                    requires_api_key: true,
                    api_key_env: Some("GEMINI_API_KEY".into()),
                },
                AgentDefinition {
                    id: "codex".into(),
                    name: "Codex".into(),
                    description: "Agente AI OpenAI Codex".into(),
                    command: "codex".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#6b46c1".into(),
                    requires_api_key: true,
                    api_key_env: Some("OPENAI_API_KEY".into()),
                },
                AgentDefinition {
                    id: "anti-gravity".into(),
                    name: "Anti-Gravity".into(),
                    description: "Agente AGY anti-gravity".into(),
                    command: "agy".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#06b6d4".into(),
                    requires_api_key: true,
                    api_key_env: Some("AGY_API_KEY".into()),
                },
            ],
        }
    }

    pub fn get_agent(&self, id: &str) -> Option<&AgentDefinition> {
        self.agents.iter().find(|a| a.id == id)
    }

    pub fn list(&self) -> Vec<serde_json::Value> {
        self.agents
            .iter()
            .map(|a| {
                serde_json::json!({
                    "id": a.id,
                    "name": a.name,
                    "description": a.description,
                    "command": a.command,
                    "args": a.args,
                    "icon": a.icon,
                    "color": a.color,
                    "requiresApiKey": a.requires_api_key,
                    "apiKeyEnv": a.api_key_env,
                })
            })
            .collect()
    }
}
