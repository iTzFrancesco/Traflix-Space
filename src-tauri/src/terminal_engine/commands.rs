#![allow(dead_code)]

use tauri::{AppHandle, Manager};
use tracing::info;

use crate::terminal_engine::cell::Cell;
use crate::terminal_engine::frame::FrameSnapshot;
use crate::terminal_engine::{TerminalContext, TerminalManager};
use crate::workspace::registry::{WorkspaceConfig, WorkspaceRegistry};

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    terminal_id: String,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    workspace_id: String,
    agent_id: Option<String>,
) -> Result<crate::terminal_engine::TerminalRuntimeIdentity, String> {
    info!(%terminal_id, "terminal_spawn called");
    let manager = app.state::<TerminalManager>();
    let config = crate::workspace::registry::TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id,
        command: None,
        cwd,
        title: "Terminal".to_string(),
        workspace_id: Some(workspace_id),
    };
    manager.spawn(app.clone(), config, cols, rows).await?;
    manager.runtime_identity(&terminal_id).await
}

#[tauri::command]
pub async fn terminal_write(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
    operation_id: Option<String>,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager
        .write_typed_for_runtime(
            &app,
            &terminal_id,
            &workspace_id,
            generation,
            process_id,
            operation_id.as_deref(),
            &data,
            crate::terminal_engine::TerminalInputOrigin::User,
        )
        .await
}

#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager
        .validate_runtime_identity(&terminal_id, &workspace_id, generation, process_id)
        .await?;
    manager
        .resize_generation(&terminal_id, generation, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_kill(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    manager
        .validate_runtime_identity(&terminal_id, &workspace_id, generation, process_id)
        .await?;
    manager
        .kill_generation(&app, &terminal_id, generation)
        .await
}

/// Persist removal only after the exact runtime was killed. The manager holds
/// the same lifecycle barrier used by spawn while checking for a replacement.
#[tauri::command]
pub async fn terminal_commit_close(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
) -> Result<WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    app.state::<TerminalManager>()
        .commit_terminal_close(
            &registry,
            &terminal_id,
            &workspace_id,
            generation,
            process_id,
        )
        .await
}

#[tauri::command]
pub async fn terminal_set_active(
    app: AppHandle,
    terminal_id: String,
    workspace_id: Option<String>,
    generation: Option<u64>,
    process_id: Option<u32>,
) -> Result<(), String> {
    let manager = app.state::<TerminalManager>();
    if terminal_id.is_empty() {
        manager.set_active(&app, None).await
    } else {
        let workspace_id = workspace_id
            .as_deref()
            .ok_or_else(|| "terminal identity missing workspaceId".to_string())?;
        let generation =
            generation.ok_or_else(|| "terminal identity missing generation".to_string())?;
        manager
            .set_active_for_runtime(&terminal_id, workspace_id, generation, process_id)
            .await
    }
}

#[tauri::command]
pub async fn terminal_get_snapshot(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    expected_generation: u64,
    expected_process_id: Option<u32>,
) -> Result<FrameSnapshot, String> {
    let manager = app.state::<TerminalManager>();
    manager
        .validate_runtime_identity(
            &terminal_id,
            &workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await?;
    manager
        .get_snapshot(&terminal_id, expected_generation)
        .await
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
    expected_generation: u64,
    expected_process_id: Option<u32>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    workspace_id: String,
    agent_id: Option<String>,
) -> Result<crate::terminal_engine::TerminalRuntimeIdentity, String> {
    info!(%terminal_id, "terminal_reopen called");
    let manager = app.state::<TerminalManager>();

    // Restart is generation-scoped. A stale request must never fall through to
    // `spawn`, where it could otherwise reuse a newer live session with the
    // same terminal id and report a false successful restart.
    manager
        .validate_runtime_identity(
            &terminal_id,
            &workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await?;
    manager
        .kill_generation(&app, &terminal_id, expected_generation)
        .await?;
    info!(%terminal_id, expected_generation, "Old session killed for reopen");

    // Poi creane una nuova
    let config = crate::workspace::registry::TerminalConfig {
        id: terminal_id.clone(),
        shell,
        agent_id,
        command: None,
        cwd,
        title: "Terminal".to_string(),
        workspace_id: Some(workspace_id),
    };
    manager.spawn(app.clone(), config, cols, rows).await?;
    manager.runtime_identity(&terminal_id).await
}

/// Visible screen, parser modes, geometry, and output watermark for rehydrating
/// xterm after a workspace remount while the backend session stays available.
#[tauri::command]
pub async fn terminal_get_screen_text(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    expected_generation: Option<u64>,
    expected_process_id: Option<u32>,
) -> Result<crate::terminal_engine::TerminalRehydrateState, String> {
    let manager = app.state::<TerminalManager>();
    manager
        .get_state_for_rehydrate(
            &terminal_id,
            &workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await
}

/// Returns the git branch for the terminal's working directory.
/// Returns null/None if not in a git repo.
#[tauri::command]
pub async fn get_git_branch(app: AppHandle, terminal_id: String) -> Result<Option<String>, String> {
    let manager = app.state::<TerminalManager>();
    manager.get_git_branch(&terminal_id).await
}

/// Returns the current directory and branch together for a terminal title bar.
#[tauri::command]
pub async fn terminal_get_context(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
) -> Result<TerminalContext, String> {
    let manager = app.state::<TerminalManager>();
    manager
        .get_terminal_context_for_runtime(&terminal_id, &workspace_id, generation, process_id)
        .await
}

/// Updates a terminal's tracked CWD from the prompt rendered by PowerShell.
#[tauri::command]
pub async fn terminal_sync_cwd(
    app: AppHandle,
    terminal_id: String,
    workspace_id: String,
    generation: u64,
    process_id: Option<u32>,
    cwd: String,
) -> Result<TerminalContext, String> {
    let manager = app.state::<TerminalManager>();
    manager
        .sync_terminal_cwd_for_runtime(&terminal_id, &workspace_id, generation, process_id, &cwd)
        .await
}
