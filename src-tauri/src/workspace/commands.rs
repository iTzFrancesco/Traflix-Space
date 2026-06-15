use tauri::AppHandle;

use super::registry::WorkspaceConfig;

#[tauri::command]
pub async fn create_workspace(
    _app: AppHandle,
    config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    // TODO: Save workspace config to .traflix/workspace.json
    Ok(config)
}

#[tauri::command]
pub async fn get_workspaces(
    _app: AppHandle,
) -> Result<Vec<WorkspaceConfig>, String> {
    // TODO: Load workspaces from registry
    Ok(vec![])
}

#[tauri::command]
pub async fn get_workspace(
    _app: AppHandle,
    id: String,
) -> Result<WorkspaceConfig, String> {
    // TODO: Get workspace by id
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn update_workspace(
    _app: AppHandle,
    id: String,
    config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    // TODO: Update workspace
    Ok(config)
}

#[tauri::command]
pub async fn delete_workspace(
    _app: AppHandle,
    id: String,
) -> Result<(), String> {
    // TODO: Delete workspace
    Ok(())
}

#[tauri::command]
pub async fn select_folder(
    _app: AppHandle,
) -> Result<String, String> {
    // TODO: Open folder dialog
    Err("Not implemented".into())
}
