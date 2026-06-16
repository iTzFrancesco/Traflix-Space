#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod process;
mod settings;
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
        .plugin(tauri_plugin_pty::init())
        .setup(|app| {
            info!("Inizializzazione stato applicazione");
            app.manage(workspace::WorkspaceRegistry::new(app.handle().clone()));
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
            agent::commands::list_agents,
            settings::commands::get_settings,
            settings::commands::set_settings,
            process::kill_process_tree,
        ])
        .run(tauri::generate_context!())
        .expect("Errore avvio Traflix Space");
}
