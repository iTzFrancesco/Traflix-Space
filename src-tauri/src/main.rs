#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod agent_events;
mod browser;
mod diagnostics;
mod jarvis;
mod project;
mod settings;
mod skills;
mod terminal_engine;
mod workspace;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{panic, path::PathBuf};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tracing::{error, info};
use tracing_appender::{non_blocking::WorkerGuard, rolling};
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

use crate::terminal_engine::TerminalManager;

fn release_log_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.traflix.space")
        .join("logs")
}

fn initialize_logging() -> Option<WorkerGuard> {
    let filter = || {
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("traflix_space=info,warn"))
    };
    let directory = release_log_directory();
    match rolling::RollingFileAppender::builder()
        .rotation(rolling::Rotation::DAILY)
        .filename_prefix("traflix-space")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&directory)
    {
        Ok(appender) => {
            let (file_writer, guard) = tracing_appender::non_blocking(appender);
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_ansi(cfg!(debug_assertions))
                .with_writer(file_writer.and(std::io::stderr))
                .init();
            Some(guard)
        }
        Err(log_error) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_writer(std::io::stderr)
                .init();
            error!(error = %log_error, "Persistent log initialization failed; using stderr only");
            None
        }
    }
}

fn install_safe_panic_hook() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current();
        error!(
            panic_location = %location,
            thread = thread.name().unwrap_or("unnamed"),
            "Unhandled Rust panic (payload intentionally omitted)"
        );
        default_hook(panic_info);
    }));
}

fn main() {
    let _log_guard = initialize_logging();
    install_safe_panic_hook();

    info!(log_directory = %release_log_directory().display(), "Avvio Traflix Space");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let state = match event.state {
                        tauri_plugin_global_shortcut::ShortcutState::Pressed => "pressed",
                        tauri_plugin_global_shortcut::ShortcutState::Released => "released",
                    };
                    let _ = app.emit(
                        "jarvis://voice-shortcut",
                        serde_json::json!({ "shortcut": shortcut.to_string(), "state": state }),
                    );
                })
                .build(),
        )
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

    let application = builder
        .setup(|app| {
            info!("Inizializzazione stato applicazione");
            settings::secrets::hydrate_process_environment(app.handle());
            app.manage(workspace::WorkspaceRegistry::new(app.handle().clone()));
            app.manage(agent::AgentRegistry::new());
            app.manage(jarvis::JarvisState::default());
            // C10: the Codex App Server provider needs managed state (runtime
            // + thread registry); attach the handle right after creation.
            app.state::<jarvis::JarvisState>()
                .model
                .attach(app.handle().clone());
            app.manage(jarvis::voice::VoiceState::default());
            app.manage(settings::store::SettingsManager::new(app.handle()));
            app.manage(TerminalManager::new());
            app.manage(project::watcher::ProjectWatcherRegistry::default());
            app.manage(agent_events::AgentEventRegistry::default());

            // Codex App Server runtime: one global process for the whole
            // session (spec §3). Warmed in background; never blocks setup.
            let codex_runtime = jarvis::codex::CodexRuntimeManager::new(app.handle().clone());
            app.manage(codex_runtime.clone());
            codex_runtime.start_in_background();

            // C3: model catalog + rate-limit snapshot service.
            app.manage(jarvis::codex::models::CodexModelService::new(
                codex_runtime.clone(),
            ));

            // C4: one ephemeral thread per workspace, isolated env.
            app.manage(jarvis::codex::threads::ThreadRegistry::new(
                codex_runtime.clone(),
                app.handle().clone(),
            ));

            // C5: read-only dynamic tools answered from the notification hub.
            app.manage(jarvis::codex::tools::CodexToolService::new(
                codex_runtime.clone(),
                app.handle().clone(),
            ));

            // Edge TTS is process-based. Warm it outside the user's first
            // spoken turn so Python/PyInstaller startup + import are not paid
            // after Jarvis has already produced a reply.
            jarvis::voice::tts::prewarm_runtime(app.handle().clone());

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
            let Some(window) = app.get_webview_window("main") else {
                error!("Main WebView window is missing during setup");
                return Err("main window is missing".into());
            };
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
            workspace::commands::update_terminal_title,
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
            jarvis::commands::jarvis_workspace_list,
            jarvis::commands::jarvis_terminal_list,
            jarvis::commands::jarvis_agent_list,
            jarvis::commands::jarvis_agent_snapshot,
            jarvis::commands::jarvis_agent_get_status,
            jarvis::commands::jarvis_agent_get_last_result,
            jarvis::commands::jarvis_agent_get_messages,
            jarvis::commands::jarvis_agent_activity,
            jarvis::commands::jarvis_agent_tail,
            jarvis::commands::jarvis_agent_open,
            jarvis::commands::jarvis_mark_selected_agent,
            jarvis::commands::jarvis_confirm_identity,
            jarvis::commands::jarvis_ignore_identity,
            jarvis::commands::jarvis_clear_identity_decision,
            jarvis::commands::jarvis_build_context,
            jarvis::commands::jarvis_refresh_context,
            jarvis::commands::jarvis_build_model_context,
            jarvis::commands::jarvis_refresh_model_context,
            jarvis::chat::jarvis_provider_status,
            jarvis::chat::jarvis_pending_actions,
            jarvis::chat::jarvis_conversation_history,
            jarvis::chat::jarvis_chat_status,
            jarvis::chat::jarvis_cancel_chat,
            jarvis::chat::jarvis_chat,
            jarvis::chat::jarvis_confirm_action,
            jarvis::chat::jarvis_update_pending_action,
            jarvis::chat::jarvis_reject_action,
            jarvis::chat::jarvis_clear_conversation,
            jarvis::codex::runtime::jarvis_codex_runtime_status,
            jarvis::codex::runtime::jarvis_codex_runtime_restart,
            jarvis::codex::account::jarvis_codex_account_read,
            jarvis::codex::account::jarvis_codex_login_start,
            jarvis::codex::account::jarvis_codex_login_cancel,
            jarvis::codex::account::jarvis_codex_logout,
            jarvis::codex::models::jarvis_codex_model_list,
            jarvis::codex::models::jarvis_codex_rate_limits,
            jarvis::codex::models::jarvis_codex_usage,
            jarvis::codex::threads::jarvis_codex_threads,
            jarvis::codex::threads::jarvis_codex_thread_ensure,
            jarvis::codex::threads::jarvis_codex_thread_delete,
            jarvis::codex::threads::jarvis_codex_turn_start,
            jarvis::codex::threads::jarvis_codex_turn_interrupt,
            jarvis::codex::threads::jarvis_codex_turn_steer,
            jarvis::voice::commands::jarvis_voice_list_input_devices,
            jarvis::voice::commands::jarvis_voice_sync_shortcut,
            jarvis::voice::commands::jarvis_voice_start,
            jarvis::voice::commands::jarvis_voice_stop,
            jarvis::voice::commands::jarvis_voice_cancel,
            jarvis::voice::commands::jarvis_voice_status,
            jarvis::voice::commands::jarvis_voice_workspace_status,
            jarvis::voice::commands::jarvis_voice_discard_transcript,
            jarvis::voice::commands::jarvis_voice_shutdown,
            jarvis::voice::commands::jarvis_tts_speak,
            jarvis::voice::commands::jarvis_tts_stop,
            jarvis::voice::commands::jarvis_tts_status,
            jarvis::voice::commands::jarvis_tts_list_voices,
            settings::commands::get_settings,
            settings::commands::set_settings,
            settings::commands::jarvis_secret_status,
            settings::commands::jarvis_set_secret,
            settings::commands::jarvis_clear_secret,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_reset,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_get_url,
            browser::browser_close,
            diagnostics::report_frontend_diagnostic,
            terminal_engine::commands::terminal_spawn,
            terminal_engine::commands::terminal_write,
            terminal_engine::commands::terminal_resize,
            terminal_engine::commands::terminal_kill,
            terminal_engine::commands::terminal_commit_close,
            terminal_engine::commands::terminal_reopen,
            terminal_engine::commands::terminal_set_active,
            terminal_engine::commands::terminal_get_snapshot,
            terminal_engine::commands::terminal_get_scrollback,
            terminal_engine::commands::terminal_get_screen_text,
            terminal_engine::commands::get_git_branch,
            terminal_engine::commands::terminal_get_context,
            terminal_engine::commands::terminal_sync_cwd,
        ])
        .build(tauri::generate_context!());
    let application = match application {
        Ok(application) => application,
        Err(build_error) => {
            error!(error = %build_error, "Tauri application build failed");
            return;
        }
    };
    application.run(|app, event| {
        // On real process exit (tray Quit, no-tray window close, OS kill),
        // tear down every PTY/shell so no orphans accumulate.
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            let _ = app.global_shortcut().unregister_all();
            let voice = app.state::<jarvis::voice::VoiceState>().clone();
            let manager = app.state::<TerminalManager>();
            tauri::async_runtime::block_on(async {
                let _ = voice.shutdown().await;
                jarvis::voice::tts::shutdown_runtime().await;
                let codex = app.state::<jarvis::codex::CodexRuntimeManager>();
                // C4: clean shutdown deletes the ephemeral Jarvis threads.
                let registry = app.state::<jarvis::codex::threads::ThreadRegistry>();
                for thread in registry.list().await.threads {
                    registry.delete_thread(&thread.workspace_id).await;
                }
                codex.shutdown().await;
                manager.kill_all().await;
            });
        }
    });
}
