use tauri::State;

use crate::mcp::{McpManager, McpStatus};

#[tauri::command]
pub fn mcp_start(manager: State<'_, McpManager>) -> Result<u32, String> {
    manager.start()
}

#[tauri::command]
pub fn mcp_stop(manager: State<'_, McpManager>) -> Result<(), String> {
    manager.stop()
}

#[tauri::command]
pub fn mcp_status(manager: State<'_, McpManager>) -> McpStatus {
    manager.status()
}

#[tauri::command]
pub fn mcp_logs() -> Result<String, String> {
    crate::mcp::read_logs()
}
