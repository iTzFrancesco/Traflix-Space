use tauri::AppHandle;

#[tauri::command]
pub async fn list_agents(
    _app: AppHandle,
) -> Result<serde_json::Value, String> {
    // TODO: Return list of available agents
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn launch_agent(
    _app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    agent_id: String,
    cwd: String,
) -> Result<(), String> {
    // TODO: Launch agent in terminal
    Ok(())
}

#[tauri::command]
pub async fn kill_agent(
    _app: AppHandle,
    agent_id: String,
) -> Result<(), String> {
    // TODO: Kill agent process
    Ok(())
}
