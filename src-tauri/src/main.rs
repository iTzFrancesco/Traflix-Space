#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod mcp;
mod settings;
mod terminal_engine;
mod workspace;

use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::terminal_engine::TerminalManager;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("traflix_space=info,warn")),
        )
        .init();

    info!("Avvio Traflix Space");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main")
                .expect("no main window")
                .set_focus();
        }))
        .setup(|app| {
            info!("Inizializzazione stato applicazione");
            app.manage(workspace::WorkspaceRegistry::new(app.handle().clone()));
            app.manage(agent::AgentRegistry::new());
            app.manage(settings::store::SettingsManager::new(app.handle()));
            app.manage(mcp::McpManager::new());
            app.manage(TerminalManager::new());
            let handle = app.handle().clone();
            let manager = app.state::<TerminalManager>();
            manager.start_event_loop(handle);
            info!("Stato applicazione inizializzato");

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let manager = handle.state::<mcp::McpManager>();
                match manager.start() {
                    Ok(pid) => info!("MCP server auto-avviato, PID: {pid}"),
                    Err(e) => warn!("Auto-avvio MCP server fallito: {e}"),
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.try_state::<mcp::McpManager>() {
                    let _ = manager.stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            workspace::commands::create_workspace,
            workspace::commands::get_workspaces,
            workspace::commands::get_workspace,
            workspace::commands::update_workspace,
            workspace::commands::delete_workspace,
            workspace::commands::select_folder,
            agent::commands::list_agents,
            mcp::commands::mcp_start,
            mcp::commands::mcp_stop,
            mcp::commands::mcp_status,
            mcp::commands::mcp_logs,
            settings::commands::get_settings,
            settings::commands::set_settings,
            terminal_engine::commands::terminal_spawn,
            terminal_engine::commands::terminal_write,
            terminal_engine::commands::terminal_resize,
            terminal_engine::commands::terminal_kill,
            terminal_engine::commands::terminal_set_active,
            terminal_engine::commands::terminal_get_snapshot,
            terminal_engine::commands::terminal_get_scrollback,
        ])
        .run(tauri::generate_context!())
        .expect("Errore avvio Traflix Space");
}
