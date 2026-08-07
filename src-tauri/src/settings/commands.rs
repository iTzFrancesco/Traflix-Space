use tauri::State;

use super::secrets::{self, JarvisSecretId, JarvisSecretStatus};
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
pub fn jarvis_secret_status() -> JarvisSecretStatus {
    secrets::status()
}

#[tauri::command]
pub fn jarvis_set_secret(
    secret: JarvisSecretId,
    value: String,
) -> Result<JarvisSecretStatus, String> {
    secrets::set_secret(secret, value)
}

#[tauri::command]
pub fn jarvis_clear_secret(secret: JarvisSecretId) -> Result<JarvisSecretStatus, String> {
    secrets::clear_secret(secret)
}
