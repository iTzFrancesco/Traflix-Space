#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod pty;
mod settings;
mod terminal;
mod workspace;

use tauri::Manager;
use tracing::info;
use tracing_subscriber::EnvFilter;

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
        .setup(|app| {
            info!("Inizializzazione stato applicazione");
            app.manage(pty::PtyManager::new());
            app.manage(workspace::WorkspaceRegistry::new(app.handle().clone()));
            app.manage(agent::AgentLauncher::new());
            app.manage(agent::AgentRegistry::new());
            app.manage(settings::store::SettingsManager::new(app.handle()));
            info!("Stato applicazione inizializzato");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::commands::create_workspace,
            workspace::commands::get_workspaces,
            workspace::commands::get_workspace,
            workspace::commands::update_workspace,
            workspace::commands::delete_workspace,
            workspace::commands::select_folder,
            pty::commands::create_pty,
            pty::commands::write_pty,
            pty::commands::resize_pty,
            pty::commands::kill_pty,
            pty::commands::get_terminal_info,
            agent::commands::list_agents,
            agent::commands::launch_agent,
            agent::commands::kill_agent,
            agent::commands::get_agent_status,
            settings::commands::get_settings,
            settings::commands::set_settings,
            settings::commands::get_api_keys,
            settings::commands::set_api_key,
            settings::commands::remove_api_key,
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
