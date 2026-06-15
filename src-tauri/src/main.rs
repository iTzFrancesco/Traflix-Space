#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod pty;
mod settings;
mod terminal;
mod workspace;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(pty::PtyManager::new());
            app.manage(workspace::WorkspaceRegistry::new(app.app_handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::commands::create_workspace,
            workspace::commands::get_workspaces,
            workspace::commands::get_workspace,
            workspace::commands::update_workspace,
            workspace::commands::delete_workspace,
            workspace::commands::select_folder,
            terminal::commands::create_pty,
            terminal::commands::write_pty,
            terminal::commands::resize_pty,
            terminal::commands::kill_pty,
            terminal::commands::get_terminal_info,
            agent::commands::list_agents,
            agent::commands::launch_agent,
            agent::commands::kill_agent,
            settings::commands::get_settings,
            settings::commands::set_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                if let Some(pty_manager) = app.try_state::<pty::PtyManager>() {
                    tauri::async_runtime::block_on(async {
                        pty_manager.cleanup_all().await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Errore avvio Traflix Space");
}
