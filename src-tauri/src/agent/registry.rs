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
}

pub struct AgentRegistry {
    agents: Vec<AgentDefinition>,
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: vec![
                AgentDefinition {
                    id: "anti-gravity".into(),
                    name: "Anti-Gravity".into(),
                    description: "Agente AGY anti-gravity".into(),
                    command: "agy".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#06b6d4".into(),
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
                },
                AgentDefinition {
                    id: "pi".into(),
                    name: "PI".into(),
                    description: "Agente AI PI".into(),
                    command: "pi".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#a855f7".into(),
                },
                AgentDefinition {
                    id: "cmdc".into(),
                    name: "Command Code".into(),
                    description: "Agente AI Command Code".into(),
                    command: "cmdc".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Terminal".into(),
                    color: "#3a86ff".into(),
                },
                AgentDefinition {
                    id: "freebuff".into(),
                    name: "Freebuff".into(),
                    description: "Agente AI Freebuff".into(),
                    command: "freebuff".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#f72585".into(),
                },
            ],
        }
    }

    #[allow(dead_code)]
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

                })
            })
            .collect()
    }
}
