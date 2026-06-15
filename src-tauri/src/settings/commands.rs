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

#[tauri::command]
pub async fn get_api_keys(manager: State<'_, SettingsManager>) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(manager.get_api_keys().await)
}

#[tauri::command]
pub async fn set_api_key(
    manager: State<'_, SettingsManager>,
    key: String,
    value: String,
) -> Result<(), String> {
    manager.set_api_key(key, value).await
}

#[tauri::command]
pub async fn remove_api_key(
    manager: State<'_, SettingsManager>,
    key: String,
) -> Result<(), String> {
    manager.remove_api_key(&key).await
}
