use tauri::AppHandle;

#[tauri::command]
pub async fn create_pty(
    _app: AppHandle,
    shell: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    // TODO: Implement ConPTY for Windows
    Ok(id)
}

#[tauri::command]
pub async fn write_pty(
    _app: AppHandle,
    id: String,
    data: String,
) -> Result<(), String> {
    // TODO: Write to PTY input
    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    _app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // TODO: Resize PTY
    Ok(())
}

#[tauri::command]
pub async fn kill_pty(
    _app: AppHandle,
    id: String,
) -> Result<(), String> {
    // TODO: Kill PTY process
    Ok(())
}

#[tauri::command]
pub async fn get_terminal_info(
    _app: AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    // TODO: Return terminal info
    Ok(serde_json::json!({ "id": id }))
}
