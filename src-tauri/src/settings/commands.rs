use tauri::State;

use super::store::{AppSettings, SettingsManager};

#[tauri::command]
pub async fn get_settings(manager: State<'_, SettingsManager>) -> Result<AppSettings, String> {
    Ok(manager.get().await)
}

#[tauri::command]
pub async fn set_settings(
    manager: State<'_, SettingsManager>,
    settings: AppSettings,
) -> Result<(), String> {
    manager.set(settings).await
}
