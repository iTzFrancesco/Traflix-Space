#![allow(dead_code)]

use tauri::{AppHandle, Manager};
use tracing::info;

use crate::terminal_engine::cell::Cell;
use crate::terminal_engine::frame::FrameSnapshot;
use crate::terminal_engine::TerminalManager;

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    terminal_id: String,
    shell: String,
    cwd: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    info!(%terminal_id, "terminal_spawn called");
    let manager = app.state::<TerminalManager>();
    let config = crate::workspace::registry::TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id: None,
        command: None,
        cwd,
        title: "Terminal".to_string(),
    };
    manager.spawn(app.clone(), config).await?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    app: AppHandle,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager.write(&terminal_id, &data).await
}

#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager.resize(&terminal_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_kill(app: AppHandle, terminal_id: String) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager.kill(&app, &terminal_id).await
}

#[tauri::command]
pub async fn terminal_set_active(app: AppHandle, terminal_id: String) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    if terminal_id.is_empty() {
        manager.set_active(&app, None).await
    } else {
        manager.set_active(&app, Some(&terminal_id)).await
    }
}

#[tauri::command]
pub async fn terminal_get_snapshot(
    app: AppHandle,
    terminal_id: String,
) -> Result<FrameSnapshot, String> {
    let manager = app.state::<TerminalManager>();
    manager.get_snapshot(&terminal_id).await
}

#[tauri::command]
pub async fn terminal_get_scrollback(
    app: AppHandle,
    terminal_id: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<Cell>>, String> {
    let manager = app.state::<TerminalManager>();
    manager.get_scrollback(&terminal_id, offset, limit).await
}

#[tauri::command]
pub async fn terminal_reopen(
    app: AppHandle,
    terminal_id: String,
    shell: String,
    cwd: String,
) -> Result<(), String> {
    info!(%terminal_id, "terminal_reopen called");
    let manager = app.state::<TerminalManager>();

    // Prima uccidi la sessione morta (se esiste)
    match manager.kill(&app, &terminal_id).await {
        Ok(_) => info!(%terminal_id, "Old session killed for reopen"),
        Err(e) => info!(%terminal_id, error = %e, "No old session to kill for reopen"),
    }

    // Poi creane una nuova
    let config = crate::workspace::registry::TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id: None,
        command: None,
        cwd,
        title: "Terminal".to_string(),
    };
    manager.spawn(app.clone(), config).await?;
    Ok(())
}

/// Plain-text screen contents for rehydrating xterm after a workspace remount
/// while the backend PTY session was kept alive.
#[tauri::command]
pub async fn terminal_get_screen_text(
    app: AppHandle,
    terminal_id: String,
) -> Result<String, String> {
    let manager = app.state::<TerminalManager>();
    manager.get_screen_text(&terminal_id).await
}
