use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

#[cfg(debug_assertions)]
const PIPE_NAMES: [&str; 2] = [
    r"\\.\pipe\traflix-voice-bridge-dev",
    r"\\.\pipe\traflix-voice-bridge",
];
#[cfg(not(debug_assertions))]
const PIPE_NAMES: [&str; 1] = [r"\\.\pipe\traflix-voice-bridge"];

pub struct VoiceBridgeState {
    sender: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl VoiceBridgeState {
    pub fn new() -> Self {
        Self {
            sender: Mutex::new(None),
        }
    }

    fn set_sender(&self, sender: Option<mpsc::UnboundedSender<String>>) {
        if let Ok(mut current) = self.sender.lock() {
            *current = sender;
        }
    }

    fn send(&self, message: String) -> Result<(), String> {
        let sender = self
            .sender
            .lock()
            .map_err(|_| "Voice bridge lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "Traflix Voice non collegato".to_string())?;
        sender
            .send(message)
            .map_err(|_| "Connessione Traflix Voice interrotta".to_string())
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_client(app).await;
    });
}

#[tauri::command]
pub async fn voice_bridge_command(
    state: State<'_, VoiceBridgeState>,
    command: String,
) -> Result<(), String> {
    let parsed = serde_json::from_str::<Value>(&command)
        .map_err(|_| "Comando Voice non valido".to_string())?;
    let kind = parsed
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Tipo comando Voice mancante".to_string())?;

    if !matches!(kind, "show_main" | "ping") {
        return Err("Comando Voice non consentito".to_string());
    }

    state.send(command)
}

async fn run_client(app: AppHandle) {
    #[cfg(windows)]
    {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::windows::named_pipe::ClientOptions;

        let mut launch_attempted = false;
        loop {
            let stream = PIPE_NAMES
                .iter()
                .find_map(|pipe_name| ClientOptions::new().open(pipe_name).ok());
            let Some(stream) = stream else {
                if !launch_attempted {
                    launch_attempted = true;
                    launch_voice_best_effort();
                }
                tokio::time::sleep(Duration::from_millis(750)).await;
                continue;
            };

            let (reader, mut writer) = tokio::io::split(stream);
            let (sender, mut commands) = mpsc::unbounded_channel::<String>();
            app.state::<VoiceBridgeState>()
                .set_sender(Some(sender.clone()));
            let _ = sender.send(r#"{"type":"attach"}"#.to_string());

            let mut lines = BufReader::new(reader).lines();
            loop {
                tokio::select! {
                    incoming = lines.next_line() => {
                        match incoming {
                            Ok(Some(line)) if line.len() <= 32 * 1024 => {
                                let _ = app.emit("voice-bridge-event", line);
                            }
                            Ok(Some(_)) => {}
                            Ok(None) | Err(_) => break,
                        }
                    }
                    command = commands.recv() => {
                        match command {
                            Some(command) => {
                                if writer.write_all(command.as_bytes()).await.is_err()
                                    || writer.write_all(b"\n").await.is_err()
                                {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                }
            }

            let _ = app.emit("voice-bridge-event", r#"{"type":"disconnected"}"#);
            app.state::<VoiceBridgeState>().set_sender(None);
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }
}

fn launch_voice_best_effort() {
    #[cfg(windows)]
    {
        let candidates = voice_executable_candidates();
        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }

            let _ = std::process::Command::new(candidate)
                .arg("--space-integration")
                .spawn();
            return;
        }
    }
}

#[cfg(windows)]
fn voice_executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("TRAFLIX_VOICE_EXE") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            add_executable_variants(&mut candidates, parent.to_path_buf());
        }
    }

    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    add_executable_variants(
        &mut candidates,
        source_root.join(r"..\..\Traflix-Voice\src-tauri\target\debug"),
    );

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local_app_data);
        add_executable_variants(&mut candidates, base.join(r"Traflix Voice"));
        add_executable_variants(&mut candidates, base.join(r"Programs\Traflix Voice"));
    }

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        add_executable_variants(
            &mut candidates,
            PathBuf::from(program_files).join(r"Traflix Voice"),
        );
    }

    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        add_executable_variants(
            &mut candidates,
            PathBuf::from(program_files_x86).join(r"Traflix Voice"),
        );
    }

    candidates
}

#[cfg(windows)]
fn add_executable_variants(candidates: &mut Vec<PathBuf>, directory: PathBuf) {
    candidates.push(directory.join("Traflix Voice.exe"));
    candidates.push(directory.join("Traflix-Voice.exe"));
}
