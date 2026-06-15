use serde::Serialize;
use tauri::{AppHandle, State};

use super::PtyManager;

#[derive(Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: u32,
    pub shell: String,
}

#[tauri::command]
pub async fn create_pty(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    shell: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    manager
        .create(id.clone(), &shell, cols, rows, cwd.as_deref(), app)
        .await?;
    Ok(id)
}

#[tauri::command]
pub async fn write_pty(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let bytes = data.into_bytes();
    manager.write(&id, &bytes).await
}

#[tauri::command]
pub async fn resize_pty(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows).await
}

#[tauri::command]
pub async fn kill_pty(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id).await
}

#[tauri::command]
pub async fn get_terminal_info(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<TerminalInfo, String> {
    let info = manager.get_info(&id).await?;
    let ti: TerminalInfo =
        serde_json::from_value(info).map_err(|e| format!("Errore deserializzazione: {}", e))?;
    Ok(ti)
}
