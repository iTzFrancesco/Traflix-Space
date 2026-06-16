use tauri::State;

use super::registry::AgentRegistry;

#[tauri::command]
pub async fn list_agents(registry: State<'_, AgentRegistry>) -> Result<Vec<serde_json::Value>, String> {
    let agents = registry.list();
    Ok(agents)
}
