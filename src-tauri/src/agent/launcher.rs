use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::agent::registry::AgentRegistry;
use crate::pty::PtyManager;

struct AgentInfo {
    agent_id: String,
    pty_id: String,
}

fn build_env_prefix(shell: &str, key: &str, value: &str) -> String {
    let lower = shell.to_lowercase();
    if lower.contains("pwsh") || lower.contains("powershell") {
        format!("$env:{}='{}'; ", key, value.replace('\'', "''"))
    } else {
        format!("export {}={} && ", key, value)
    }
}

pub struct AgentLauncher {
    running_agents: Arc<Mutex<HashMap<String, AgentInfo>>>,
}

impl AgentLauncher {
    pub fn new() -> Self {
        Self {
            running_agents: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn launch(
        &self,
        pty_id: &str,
        terminal_id: &str,
        agent_id: &str,
        shell: &str,
        api_keys: &HashMap<String, String>,
        pty_manager: &PtyManager,
        registry: &AgentRegistry,
    ) -> Result<(), String> {
        let agent = registry.get_agent(agent_id).ok_or_else(|| {
            warn!(%agent_id, "Agente non trovato nel registry");
            format!("Agente '{}' non trovato", agent_id)
        })?;

        let mut cmd = agent.command.clone();

        if !agent.args.is_empty() {
            cmd.push(' ');
            cmd.push_str(&agent.args.join(" "));
        }

        let mut env_prefix = String::new();
        if agent.requires_api_key {
            if let Some(ref key_env) = agent.api_key_env {
                if let Some(api_key) = api_keys.get(key_env) {
                    if !api_key.is_empty() {
                        env_prefix = build_env_prefix(shell, key_env, api_key);
                        info!(%agent_id, %terminal_id, "API key impostata per agente");
                    }
                }
            }
        }

        let full_cmd = format!("{}{}\r\n", env_prefix, cmd);
        let cmd_bytes = full_cmd.into_bytes();
        pty_manager.write(pty_id, &cmd_bytes)?;

        info!(%agent_id, %terminal_id, %pty_id, "Agente lanciato");

        self.running_agents.lock().await.insert(
            terminal_id.to_string(),
            AgentInfo {
                agent_id: agent_id.to_string(),
                pty_id: pty_id.to_string(),
            },
        );

        Ok(())
    }

    pub async fn kill(&self, terminal_id: &str, pty_manager: &PtyManager) {
        let mut agents = self.running_agents.lock().await;
        if let Some(info) = agents.remove(terminal_id) {
            let _ = pty_manager.kill(&info.pty_id);
            info!(%terminal_id, "Agente terminato");
        }
    }

    pub async fn is_running(&self, terminal_id: &str) -> bool {
        self.running_agents.lock().await.contains_key(terminal_id)
    }

    pub async fn get_agent_id(&self, terminal_id: &str) -> Option<String> {
        self.running_agents
            .lock()
            .await
            .get(terminal_id)
            .map(|info| info.agent_id.clone())
    }
}
