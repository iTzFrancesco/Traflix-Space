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
    /// Bounded screen hints used only by the conversational readiness probe.
    pub readiness_hints: Vec<String>,
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
        // Every provider exposed by the frontend catalog is also represented
        // here so Jarvis can open and communicate through the same visible PTY
        // contract.
        Self {
            agents: vec![
                AgentDefinition {
                    id: "anti-gravity".into(),
                    name: "Anti-Gravity".into(),
                    description: "Agente AI Anti-Gravity / AGY".into(),
                    command: "agy".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#06b6d4".into(),
                    readiness_hints: vec!["anti-gravity".into(), "agy".into(), "›".into()],
                },
                AgentDefinition {
                    id: "claude".into(),
                    name: "Claude Code".into(),
                    description: "Agente AI Claude di Anthropic".into(),
                    command: "claude".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "MessageSquare".into(),
                    color: "#d97757".into(),
                    readiness_hints: vec!["❯".into(), "anthropic".into()],
                },
                AgentDefinition {
                    id: "claudex".into(),
                    name: "Claudex".into(),
                    description: "Agente AI Claudex".into(),
                    command: "claudex".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "MessageSquare".into(),
                    color: "#a855f7".into(),
                    readiness_hints: vec!["❯".into(), "anthropic".into()],
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
                    readiness_hints: vec!["›".into(), "shortcuts".into(), "openai".into()],
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
                    readiness_hints: vec!["help".into(), "open files".into(), "build".into()],
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
                    readiness_hints: vec!["assistant".into(), "tools".into(), "model".into()],
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
                    readiness_hints: vec!["assistant".into(), "tools".into(), "ready".into()],
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
                    readiness_hints: vec!["command".into(), "assistant".into(), "ready".into()],
                },
                AgentDefinition {
                    id: "cline".into(),
                    name: "Cline".into(),
                    description: "Agente AI Cline".into(),
                    command: "cline".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#6366f1".into(),
                    readiness_hints: vec!["cline".into(), "assistant".into(), "ready".into()],
                },
                AgentDefinition {
                    id: "grok".into(),
                    name: "Grok".into(),
                    description: "Agente AI Grok di xAI".into(),
                    command: "grok".into(),
                    args: vec![],
                    env: std::collections::HashMap::new(),
                    icon: "Bot".into(),
                    color: "#111827".into(),
                    readiness_hints: vec!["grok".into(), "xai".into(), "›".into()],
                },
            ],
        }
    }

    #[allow(dead_code)]
    pub fn get_agent(&self, id: &str) -> Option<&AgentDefinition> {
        let normalized = crate::jarvis::runtime_detector::normalize_provider(id)?;
        self.agents.iter().find(|a| a.id == normalized)
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
                    "readinessHints": a.readiness_hints,

                })
            })
            .collect()
    }
}
