use tauri::AppHandle;

use super::store::AppSettings;

#[tauri::command]
pub async fn get_settings(
    _app: AppHandle,
) -> Result<AppSettings, String> {
    // TODO: Load settings from store
    Ok(AppSettings::default())
}

#[tauri::command]
pub async fn set_settings(
    _app: AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    // TODO: Save settings to store
    Ok(())
}
