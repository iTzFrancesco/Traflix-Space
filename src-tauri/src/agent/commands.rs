use tauri::{AppHandle, Manager, State};

use super::launcher::AgentLauncher;
use super::registry::AgentRegistry;
use crate::pty::PtyManager;
use crate::settings::store::SettingsManager;

#[tauri::command]
pub async fn list_agents(registry: State<'_, AgentRegistry>) -> Result<Vec<serde_json::Value>, String> {
    let agents = registry.list();
    Ok(agents)
}

#[tauri::command]
pub async fn launch_agent(
    app: AppHandle,
    pty_id: String,
    terminal_id: String,
    agent_id: String,
    shell: String,
) -> Result<(), String> {
    let pty_manager = app.state::<PtyManager>();
    let launcher = app.state::<AgentLauncher>();
    let registry = app.state::<AgentRegistry>();
    let settings_manager = app.state::<SettingsManager>();

    let api_keys = settings_manager.get_api_keys().await;

    launcher
        .launch(&pty_id, &terminal_id, &agent_id, &shell, &api_keys, &pty_manager, &registry)
        .await
}

#[tauri::command]
pub async fn kill_agent(
    app: AppHandle,
    terminal_id: String,
) -> Result<(), String> {
    let launcher = app.state::<AgentLauncher>();
    let pty_manager = app.state::<PtyManager>();
    launcher.kill(&terminal_id, &pty_manager).await;
    Ok(())
}

#[tauri::command]
pub async fn get_agent_status(
    app: AppHandle,
    terminal_id: String,
) -> Result<serde_json::Value, String> {
    let launcher = app.state::<AgentLauncher>();
    let running = launcher.is_running(&terminal_id).await;
    let agent_id = launcher.get_agent_id(&terminal_id).await;

    Ok(serde_json::json!({
        "running": running,
        "agentId": agent_id,
    }))
}
