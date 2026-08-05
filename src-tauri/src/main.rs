#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod agent_events;
mod browser;
mod project;
mod settings;
mod skills;
mod terminal_engine;
mod workspace;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};
use tracing::info;
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_pty::init());

    // Solo in release: evita che il dev vada in conflitto con l'istanza installata
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // Se la finestra è nascosta in tray, mostrala prima di mettere a fuoco
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            info!("Inizializzazione stato applicazione");
            app.manage(workspace::WorkspaceRegistry::new(app.handle().clone()));
            app.manage(agent::AgentRegistry::new());
            app.manage(settings::store::SettingsManager::new(app.handle()));
            app.manage(TerminalManager::new());
            app.manage(project::watcher::ProjectWatcherRegistry::default());
            app.manage(agent_events::AgentEventRegistry::default());

            // Agent hooks/plugins forward normalized turn-complete events to
            // this local Windows named pipe. The listener is best-effort and
            // never participates in the agent's execution path.
            agent_events::start_listener(app.handle().clone());

            // Avvia skills watcher
            skills::watcher::start_skills_watcher(app.handle().clone());

            let handle = app.handle().clone();
            let manager = app.state::<TerminalManager>();
            manager.start_event_loop(handle);

            // Flag condiviso: la tray è stata creata con successo?
            let tray_ok = Arc::new(AtomicBool::new(false));
            let tray_ok_close = tray_ok.clone();

            // Crea icona della tray di sistema
            if let Some(default_icon) = app.default_window_icon().cloned() {
                let show = MenuItemBuilder::with_id("show", "Mostra Traflix Space").build(app)?;
                let quit = PredefinedMenuItem::quit(app, Some("Esci"))?;
                let menu = MenuBuilder::new(app)
                    .item(&show)
                    .separator()
                    .item(&quit)
                    .build()?;

                TrayIconBuilder::new()
                    .icon(default_icon)
                    .menu(&menu)
                    .tooltip(if cfg!(debug_assertions) {
                        "Traflix Space [DEV]"
                    } else {
                        "Traflix Space"
                    })
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "show" {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                tray_ok.store(true, Ordering::Release);
                info!("Tray icon creata con successo");
            } else {
                info!("Nessuna icona di default — la finestra si chiuderà normalmente");
            }

            // Registra on_window_event DOPO aver stabilito se la tray è attiva
            let win_tray_ok = tray_ok_close.clone();
            let app_handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if win_tray_ok.load(Ordering::Acquire) {
                        // Tray presente: nascondi la finestra invece di chiudere
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    // Se non c'è tray, la chiusura procede normalmente
                }
            });

            // Imposta titolo finestra per DEV mode
            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("Traflix Space [DEV]");
                }
            }

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
            workspace::commands::navigate_folder,
            workspace::commands::get_default_workspace_path,
            project::commands::project_list_directory,
            project::commands::project_git_status,
            project::commands::project_git_diff,
            project::commands::project_git_stage,
            project::commands::project_git_unstage,
            project::commands::project_git_discard,
            project::commands::project_git_commit,
            project::commands::project_git_sync,
            project::commands::project_open_file,
            project::commands::project_read_file,
            project::commands::project_watch_workspace,
            project::commands::project_unwatch_workspace,
            skills::commands::list_skills,
            agent::commands::list_agents,
            settings::commands::get_settings,
            settings::commands::set_settings,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_reset,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_get_url,
            browser::browser_close,
            terminal_engine::commands::terminal_spawn,
            terminal_engine::commands::terminal_write,
            terminal_engine::commands::terminal_resize,
            terminal_engine::commands::terminal_kill,
            terminal_engine::commands::terminal_reopen,
            terminal_engine::commands::terminal_set_active,
            terminal_engine::commands::terminal_get_snapshot,
            terminal_engine::commands::terminal_get_scrollback,
            terminal_engine::commands::terminal_get_screen_text,
            terminal_engine::commands::get_git_branch,
            terminal_engine::commands::terminal_get_context,
            terminal_engine::commands::terminal_sync_cwd,
        ])
        .build(tauri::generate_context!())
        .expect("Errore build Traflix Space")
        .run(|app, event| {
            // On real process exit (tray Quit, no-tray window close, OS kill),
            // tear down every PTY/shell so no orphans accumulate.
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                let manager = app.state::<TerminalManager>();
                tauri::async_runtime::block_on(async {
                    manager.kill_all().await;
                });
            }
        });
}
