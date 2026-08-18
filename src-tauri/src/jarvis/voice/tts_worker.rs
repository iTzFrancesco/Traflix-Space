#[cfg(debug_assertions)]
use std::path::{Path, PathBuf};

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
#[cfg(debug_assertions)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(debug_assertions)]
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::{
    helper_operation, EdgeHelper, HelperRequest, VoiceErrorCode, HELPER_OUTPUT_LIMIT,
    HELPER_QUEUE_DEPTH, HELPER_TIMEOUT,
};

#[cfg(debug_assertions)]
pub(super) fn spawn_helper_process(path: &Path) -> Result<tokio::process::Child, VoiceErrorCode> {
    if path.extension().and_then(|value| value.to_str()) == Some("exe") {
        return Command::new(path)
            .env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV)
            .env_remove(crate::settings::secrets::GROQ_API_KEY_ENV)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| VoiceErrorCode::HelperFailed);
    }

    let mut commands = Vec::new();
    if cfg!(windows) {
        let mut launcher = Command::new("py");
        launcher.args(["-3", "-u"]).arg(path);
        commands.push(launcher);
    }
    for executable in if cfg!(windows) {
        vec!["python", "python3"]
    } else {
        vec!["python3", "python"]
    } {
        let mut command = Command::new(executable);
        command.args(["-u"]).arg(path);
        commands.push(command);
    }

    for mut command in commands {
        command
            .env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV)
            .env_remove(crate::settings::secrets::GROQ_API_KEY_ENV);
        match command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(_)) => continue,
                Ok(None) => return Ok(child),
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }
    Err(VoiceErrorCode::HelperFailed)
}

pub(super) async fn spawn_helper_worker(
    helper: EdgeHelper,
) -> Result<mpsc::Sender<HelperRequest>, VoiceErrorCode> {
    match helper {
        #[cfg(debug_assertions)]
        EdgeHelper::Python(path) => spawn_python_worker(path).await,
        #[cfg(not(debug_assertions))]
        EdgeHelper::Sidecar(app) => spawn_sidecar_worker(app).await,
    }
}

#[cfg(debug_assertions)]
async fn spawn_python_worker(
    helper_path: PathBuf,
) -> Result<mpsc::Sender<HelperRequest>, VoiceErrorCode> {
    // Windows App Execution Aliases can leave `python.exe` pointing at the
    // Microsoft Store stub even when the real launcher is available as `py`.
    // Prefer the Windows launcher, then fall back to the conventional names.
    info!(
        helper_path = %helper_path.display(),
        "[JARVIS-TTS-HELPER] starting Python helper",
    );
    let mut child = match spawn_helper_process(&helper_path) {
        Ok(child) => child,
        Err(code) => {
            error!(
                error_code = %code.as_str(),
                "[JARVIS-TTS-HELPER] Python helper process failed to start",
            );
            return Err(code);
        }
    };
    let mut stdin = child.stdin.take().ok_or(VoiceErrorCode::HelperFailed)?;
    let stdout = child.stdout.take().ok_or(VoiceErrorCode::HelperFailed)?;
    let mut lines = BufReader::new(stdout).lines();
    let (sender, mut requests) = mpsc::channel::<HelperRequest>(HELPER_QUEUE_DEPTH);

    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                HelperRequest::Run {
                    context,
                    payload,
                    cancellation,
                    response,
                } => {
                    let operation = helper_operation(&payload);
                    debug!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        "[JARVIS-TTS-HELPER] Python helper request received",
                    );
                    if stdin.write_all(payload.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        error!(
                            request_id = ?context.request_id,
                            workspace_id = ?context.workspace_id,
                            operation,
                            "[JARVIS-TTS-HELPER] Python helper stdin write failed",
                        );
                        let _ = response.send(Err(VoiceErrorCode::HelperFailed));
                        break;
                    }
                    let result = tokio::select! {
                        _ = cancellation.cancelled() => {
                            info!(
                                request_id = ?context.request_id,
                                workspace_id = ?context.workspace_id,
                                operation,
                                "[JARVIS-TTS-HELPER] Python helper request cancelled",
                            );
                            let _ = child.kill().await;
                            Err(VoiceErrorCode::Cancelled)
                        }
                        result = tokio::time::timeout(HELPER_TIMEOUT, lines.next_line()) => {
                            match result {
                                Ok(Ok(Some(line))) if line.len() <= HELPER_OUTPUT_LIMIT => {
                                    debug!(
                                        request_id = ?context.request_id,
                                        workspace_id = ?context.workspace_id,
                                        operation,
                                        response_bytes = line.len(),
                                        "[JARVIS-TTS-HELPER] Python helper response received",
                                    );
                                    Ok(line.into_bytes())
                                }
                                _ => {
                                    warn!(
                                        request_id = ?context.request_id,
                                        workspace_id = ?context.workspace_id,
                                        operation,
                                        max_response_bytes = HELPER_OUTPUT_LIMIT,
                                        "[JARVIS-TTS-HELPER] Python helper response timed out, closed, or exceeded limit",
                                    );
                                    let _ = child.kill().await;
                                    Err(VoiceErrorCode::HelperFailed)
                                }
                            }
                        }
                    };
                    let fatal = result.is_err();
                    let _ = response.send(result);
                    if fatal {
                        warn!(
                            request_id = ?context.request_id,
                            workspace_id = ?context.workspace_id,
                            operation,
                            "[JARVIS-TTS-HELPER] Python helper worker stopping after fatal request",
                        );
                        break;
                    }
                }
                HelperRequest::Shutdown { response } => {
                    info!("[JARVIS-TTS-HELPER] stopping Python helper worker");
                    let _ = child.kill().await;
                    let _ = response.send(());
                    return;
                }
            }
        }
        let _ = child.kill().await;
    });
    Ok(sender)
}

#[cfg(not(debug_assertions))]
async fn spawn_sidecar_worker(
    app: tauri::AppHandle,
) -> Result<mpsc::Sender<HelperRequest>, VoiceErrorCode> {
    info!("[JARVIS-TTS-HELPER] starting bundled sidecar");
    let command = app
        .shell()
        .sidecar("jarvis-edge-tts")
        .map_err(|error| {
            error!(
                error = %error,
                "[JARVIS-TTS-HELPER] sidecar command lookup failed",
            );
            VoiceErrorCode::HelperFailed
        })?
        .set_raw_out(true);
    let (mut events, child) = command.spawn().map_err(|error| {
        error!(
            error = %error,
            "[JARVIS-TTS-HELPER] sidecar process failed to start",
        );
        VoiceErrorCode::HelperFailed
    })?;
    info!("[JARVIS-TTS-HELPER] bundled sidecar started");
    let mut child = Some(child);
    let (sender, mut requests) = mpsc::channel::<HelperRequest>(HELPER_QUEUE_DEPTH);

    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                HelperRequest::Run {
                    context,
                    payload,
                    cancellation,
                    response,
                } => {
                    let operation = helper_operation(&payload);
                    debug!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        "[JARVIS-TTS-HELPER] sidecar request received",
                    );
                    let Some(running) = child.as_mut() else {
                        error!(
                            request_id = ?context.request_id,
                            workspace_id = ?context.workspace_id,
                            operation,
                            "[JARVIS-TTS-HELPER] sidecar process handle is unavailable",
                        );
                        let _ = response.send(Err(VoiceErrorCode::HelperFailed));
                        break;
                    };
                    if running.write(payload.as_bytes()).is_err() || running.write(b"\n").is_err() {
                        error!(
                            request_id = ?context.request_id,
                            workspace_id = ?context.workspace_id,
                            operation,
                            "[JARVIS-TTS-HELPER] sidecar stdin write failed",
                        );
                        if let Some(running) = child.take() {
                            let _ = running.kill();
                        }
                        let _ = response.send(Err(VoiceErrorCode::HelperFailed));
                        break;
                    }

                    let result = tokio::time::timeout(HELPER_TIMEOUT, async {
                        let mut stdout = Vec::new();
                        loop {
                            tokio::select! {
                                _ = cancellation.cancelled() => {
                                    info!(
                                        request_id = ?context.request_id,
                                        workspace_id = ?context.workspace_id,
                                        operation,
                                        "[JARVIS-TTS-HELPER] sidecar request cancelled",
                                    );
                                    if let Some(running) = child.take() { let _ = running.kill(); }
                                    return Err(VoiceErrorCode::Cancelled);
                                }
                                event = events.recv() => match event {
                                    Some(CommandEvent::Stdout(bytes)) => {
                                        if stdout.len().saturating_add(bytes.len()) > HELPER_OUTPUT_LIMIT {
                                            if let Some(running) = child.take() { let _ = running.kill(); }
                                            return Err(VoiceErrorCode::HelperFailed);
                                        }
                                        stdout.extend_from_slice(&bytes);
                                        if let Some(newline) = stdout.iter().position(|byte| *byte == b'\n') {
                                            stdout.truncate(newline);
                                            debug!(
                                                request_id = ?context.request_id,
                                                workspace_id = ?context.workspace_id,
                                                operation,
                                                response_bytes = stdout.len(),
                                                "[JARVIS-TTS-HELPER] sidecar response received",
                                            );
                                            return Ok(stdout);
                                        }
                                    }
                                    Some(CommandEvent::Terminated(_)) => {
                                        error!(
                                            request_id = ?context.request_id,
                                            workspace_id = ?context.workspace_id,
                                            operation,
                                            "[JARVIS-TTS-HELPER] sidecar terminated before response",
                                        );
                                        let _ = child.take();
                                        return Err(VoiceErrorCode::HelperFailed);
                                    }
                                    Some(CommandEvent::Error(_)) => {
                                        error!(
                                            request_id = ?context.request_id,
                                            workspace_id = ?context.workspace_id,
                                            operation,
                                            "[JARVIS-TTS-HELPER] sidecar emitted process error",
                                        );
                                        if let Some(running) = child.take() { let _ = running.kill(); }
                                        return Err(VoiceErrorCode::HelperFailed);
                                    }
                                    Some(CommandEvent::Stderr(bytes)) => {
                                        warn!(
                                            request_id = ?context.request_id,
                                            workspace_id = ?context.workspace_id,
                                            operation,
                                            stderr_bytes = bytes.len(),
                                            "[JARVIS-TTS-HELPER] sidecar stderr output received",
                                        );
                                    }
                                    None => {
                                        error!(
                                            request_id = ?context.request_id,
                                            workspace_id = ?context.workspace_id,
                                            operation,
                                            "[JARVIS-TTS-HELPER] sidecar event stream closed",
                                        );
                                        if let Some(running) = child.take() { let _ = running.kill(); }
                                        return Err(VoiceErrorCode::HelperFailed);
                                    }
                                    Some(_) => {}
                                }
                            }
                        }
                    })
                    .await;
                    let result = match result {
                        Ok(result) => result,
                        Err(error) => {
                            error!(
                                request_id = ?context.request_id,
                                workspace_id = ?context.workspace_id,
                                operation,
                                error = %error,
                                "[JARVIS-TTS-HELPER] sidecar response timed out",
                            );
                            if let Some(running) = child.take() {
                                let _ = running.kill();
                            }
                            Err(VoiceErrorCode::HelperFailed)
                        }
                    };
                    let fatal = result.is_err();
                    let _ = response.send(result);
                    if fatal {
                        warn!(
                            request_id = ?context.request_id,
                            workspace_id = ?context.workspace_id,
                            operation,
                            "[JARVIS-TTS-HELPER] sidecar worker stopping after fatal request",
                        );
                        break;
                    }
                }
                HelperRequest::Shutdown { response } => {
                    info!("[JARVIS-TTS-HELPER] stopping bundled sidecar");
                    if let Some(running) = child.take() {
                        let _ = running.kill();
                    }
                    let _ = response.send(());
                    return;
                }
            }
        }
        if let Some(running) = child.take() {
            let _ = running.kill();
        }
    });
    Ok(sender)
}
