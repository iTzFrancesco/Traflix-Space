use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
#[cfg(debug_assertions)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(debug_assertions)]
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use super::types::{VoiceErrorCode, MAX_MP3_BYTES};

const MAX_HELPER_OUTPUT_BYTES: usize = 64 * 1024;
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const HELPER_QUEUE_DEPTH: usize = 4;

fn helper_operation(payload: &str) -> &'static str {
    if payload.contains(r#""action":"ping""#) {
        "ping"
    } else if payload.contains(r#""action":"listVoices""#) {
        "list_voices"
    } else {
        "speak"
    }
}

pub type TtsFuture = Pin<Box<dyn Future<Output = Result<PathBuf, VoiceErrorCode>> + Send>>;

type HelperSender = mpsc::Sender<HelperRequest>;
type SharedWorker = Arc<AsyncMutex<Option<HelperSender>>>;

#[derive(Clone, Debug, Default)]
struct HelperContext {
    request_id: Option<String>,
    workspace_id: Option<String>,
}

enum HelperRequest {
    Run {
        context: HelperContext,
        payload: String,
        cancellation: CancellationToken,
        response: oneshot::Sender<Result<Vec<u8>, VoiceErrorCode>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

fn shared_worker() -> SharedWorker {
    static WORKER: OnceLock<SharedWorker> = OnceLock::new();
    Arc::clone(WORKER.get_or_init(|| Arc::new(AsyncMutex::new(None))))
}

async fn shutdown_shared_worker() {
    let worker = shared_worker();
    let sender = worker.lock().await.take();
    let Some(sender) = sender else {
        return;
    };
    let (response, finished) = oneshot::channel();
    if sender
        .send(HelperRequest::Shutdown { response })
        .await
        .is_ok()
    {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), finished).await;
    }
}

pub trait TextToSpeechProvider: Send + Sync {
    fn speak(
        &self,
        request_id: String,
        workspace_id: Option<String>,
        text: String,
        voice: String,
        rate: String,
        volume: String,
        pitch: String,
        cancellation: CancellationToken,
    ) -> TtsFuture;
}

#[derive(Clone)]
pub struct EdgeTextToSpeechProvider {
    helper: EdgeHelper,
    worker: SharedWorker,
}

#[derive(Clone)]
enum EdgeHelper {
    #[cfg(debug_assertions)]
    Python(PathBuf),
    #[cfg(not(debug_assertions))]
    Sidecar(tauri::AppHandle),
}

impl EdgeTextToSpeechProvider {
    #[cfg(debug_assertions)]
    pub fn new(helper_path: PathBuf) -> Self {
        Self {
            helper: EdgeHelper::Python(helper_path),
            worker: shared_worker(),
        }
    }

    #[cfg(debug_assertions)]
    pub fn debug(helper_path: PathBuf) -> Self {
        Self::new(helper_path)
    }

    #[cfg(not(debug_assertions))]
    pub fn release(app: tauri::AppHandle) -> Self {
        Self {
            helper: EdgeHelper::Sidecar(app),
            worker: shared_worker(),
        }
    }

    pub async fn prewarm(&self) -> Result<(), VoiceErrorCode> {
        info!("[JARVIS-TTS-HELPER] prewarm started");
        let bytes = self
            .run_helper(
                HelperContext::default(),
                r#"{"action":"ping"}"#.to_string(),
                CancellationToken::new(),
            )
            .await?;
        let result: HelperResult = match serde_json::from_slice(&bytes) {
            Ok(result) => result,
            Err(error) => {
                error!(
                    response_bytes = bytes.len(),
                    error = %error,
                    "[JARVIS-TTS-HELPER] prewarm response was not valid JSON",
                );
                self.reset_worker().await;
                return Err(VoiceErrorCode::HelperFailed);
            }
        };
        if result.ok {
            info!("[JARVIS-TTS-HELPER] prewarm completed");
            Ok(())
        } else {
            warn!(
                response_bytes = bytes.len(),
                "[JARVIS-TTS-HELPER] prewarm rejected by helper; resetting worker",
            );
            self.reset_worker().await;
            Err(helper_error_code(result.error.as_deref()))
        }
    }

    async fn worker_sender(&self) -> Result<HelperSender, VoiceErrorCode> {
        let mut worker = self.worker.lock().await;
        if let Some(sender) = worker.as_ref() {
            if !sender.is_closed() {
                debug!("[JARVIS-TTS-HELPER] reusing helper worker");
                return Ok(sender.clone());
            }
            warn!("[JARVIS-TTS-HELPER] cached helper worker is closed; spawning replacement");
        }
        info!(
            runtime = if cfg!(debug_assertions) {
                "python"
            } else {
                "sidecar"
            },
            "[JARVIS-TTS-HELPER] spawning helper worker",
        );
        let sender = spawn_helper_worker(self.helper.clone()).await?;
        *worker = Some(sender.clone());
        Ok(sender)
    }

    async fn reset_worker(&self) {
        debug!("[JARVIS-TTS-HELPER] resetting cached helper worker");
        self.worker.lock().await.take();
    }

    async fn run_helper(
        &self,
        context: HelperContext,
        payload: String,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, VoiceErrorCode> {
        let operation = helper_operation(&payload);
        for attempt in 0..2 {
            if cancellation.is_cancelled() {
                info!(
                    request_id = ?context.request_id,
                    workspace_id = ?context.workspace_id,
                    operation,
                    attempt = attempt + 1,
                    "[JARVIS-TTS-HELPER] request cancelled before dispatch",
                );
                return Err(VoiceErrorCode::Cancelled);
            }
            debug!(
                request_id = ?context.request_id,
                workspace_id = ?context.workspace_id,
                operation,
                attempt = attempt + 1,
                max_attempts = 2,
                "[JARVIS-TTS-HELPER] dispatching request",
            );
            let sender = self.worker_sender().await?;
            let (response, result) = oneshot::channel();
            if sender
                .send(HelperRequest::Run {
                    context: context.clone(),
                    payload: payload.clone(),
                    cancellation: cancellation.clone(),
                    response,
                })
                .await
                .is_err()
            {
                warn!(
                    request_id = ?context.request_id,
                    workspace_id = ?context.workspace_id,
                    operation,
                    attempt = attempt + 1,
                    "[JARVIS-TTS-HELPER] helper request could not be queued",
                );
                self.reset_worker().await;
                if attempt == 0 {
                    continue;
                }
                return Err(VoiceErrorCode::HelperFailed);
            }
            match result.await {
                Ok(Ok(bytes)) => {
                    debug!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        response_bytes = bytes.len(),
                        "[JARVIS-TTS-HELPER] helper response received",
                    );
                    return Ok(bytes);
                }
                Ok(Err(VoiceErrorCode::Cancelled)) => {
                    info!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        "[JARVIS-TTS-HELPER] helper request cancelled",
                    );
                    return Err(VoiceErrorCode::Cancelled);
                }
                Ok(Err(code)) if attempt == 0 => {
                    warn!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        error_code = %code.as_str(),
                        "[JARVIS-TTS-HELPER] helper request failed; resetting before retry",
                    );
                    self.reset_worker().await;
                }
                Ok(Err(code)) => {
                    error!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        error_code = %code.as_str(),
                        "[JARVIS-TTS-HELPER] helper request failed after retry",
                    );
                    return Err(code);
                }
                Err(error) if attempt == 0 => {
                    warn!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        error = %error,
                        "[JARVIS-TTS-HELPER] helper response channel closed; resetting before retry",
                    );
                    self.reset_worker().await;
                }
                Err(error) => {
                    error!(
                        request_id = ?context.request_id,
                        workspace_id = ?context.workspace_id,
                        operation,
                        attempt = attempt + 1,
                        error = %error,
                        "[JARVIS-TTS-HELPER] helper response channel closed after retry",
                    );
                    return Err(VoiceErrorCode::HelperFailed);
                }
            }
        }
        error!(
            request_id = ?context.request_id,
            workspace_id = ?context.workspace_id,
            operation,
            "[JARVIS-TTS-HELPER] helper request exhausted retries",
        );
        Err(VoiceErrorCode::HelperFailed)
    }

    pub async fn list_voices(&self) -> Result<Vec<TtsVoiceInfo>, VoiceErrorCode> {
        let bytes = self
            .run_helper(
                HelperContext::default(),
                r#"{"action":"listVoices"}"#.to_string(),
                CancellationToken::new(),
            )
            .await?;
        let result: VoiceListResult =
            serde_json::from_slice(&bytes).map_err(|_| VoiceErrorCode::HelperFailed)?;
        if !result.ok {
            return Err(helper_error_code(result.error.as_deref()));
        }
        Ok(result.voices.unwrap_or_default())
    }
}

#[cfg(debug_assertions)]
fn runtime_prewarm_provider(app: &tauri::AppHandle) -> EdgeTextToSpeechProvider {
    let helper_path = std::env::var("TRAF_EDGE_TTS_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/jarvis-edge-tts.py")
        });
    let _ = app;
    EdgeTextToSpeechProvider::debug(helper_path)
}

#[cfg(not(debug_assertions))]
fn runtime_prewarm_provider(app: &tauri::AppHandle) -> EdgeTextToSpeechProvider {
    EdgeTextToSpeechProvider::release(app.clone())
}

pub fn prewarm_runtime(app: tauri::AppHandle) {
    let provider = runtime_prewarm_provider(&app);
    tauri::async_runtime::spawn(async move {
        let _ = provider.prewarm().await;
    });
}

pub async fn shutdown_runtime() {
    shutdown_shared_worker().await;
}

impl TextToSpeechProvider for EdgeTextToSpeechProvider {
    fn speak(
        &self,
        request_id: String,
        workspace_id: Option<String>,
        text: String,
        voice: String,
        rate: String,
        volume: String,
        pitch: String,
        cancellation: CancellationToken,
    ) -> TtsFuture {
        let provider = self.clone();
        Box::pin(async move {
            let request_id_for_log = request_id.clone();
            let workspace_id_for_log = workspace_id.clone();
            let output_path = temp_audio_path(&request_id);
            debug!(
                request_id = %request_id_for_log,
                workspace_id = ?workspace_id_for_log,
                text_chars = text.chars().count(),
                output_file = output_path.file_name().and_then(|name| name.to_str()).unwrap_or("unknown"),
                "[JARVIS-TTS-HELPER] synthesis payload prepared",
            );
            let result = async {
                let payload = serde_json::json!({ "requestId": request_id, "text": text, "voice": voice, "rate": rate, "volume": volume, "pitch": pitch, "outputPath": output_path }).to_string();
                let stdout_bytes = provider
                    .run_helper(
                        HelperContext {
                            request_id: Some(request_id_for_log.clone()),
                            workspace_id: workspace_id_for_log.clone(),
                        },
                        payload,
                        cancellation.clone(),
                    )
                    .await?;
                let result: HelperResult = match serde_json::from_slice(&stdout_bytes) {
                    Ok(result) => result,
                    Err(error) => {
                        error!(
                            request_id = %request_id_for_log,
                            workspace_id = ?workspace_id_for_log,
                            response_bytes = stdout_bytes.len(),
                            error = %error,
                            "[JARVIS-TTS-HELPER] synthesis response was not valid JSON",
                        );
                        return Err(VoiceErrorCode::HelperFailed);
                    }
                };
                if !result.ok {
                    warn!(
                        request_id = %request_id_for_log,
                        workspace_id = ?workspace_id_for_log,
                        response_bytes = stdout_bytes.len(),
                        helper_error = ?result.error,
                        "[JARVIS-TTS-HELPER] synthesis helper returned ok=false",
                    );
                    return Err(helper_error_code(result.error.as_deref()));
                }
                let returned = PathBuf::from(result.output_path.unwrap_or_default());
                let canonical = match canonical_temp_file(&returned) {
                    Some(path) => path,
                    None => {
                        error!(
                            request_id = %request_id_for_log,
                            workspace_id = ?workspace_id_for_log,
                            "[JARVIS-TTS-HELPER] helper returned an unsafe output path",
                        );
                        return Err(VoiceErrorCode::HelperFailed);
                    }
                };
                let generated = match canonical_temp_file(&output_path) {
                    Some(path) => path,
                    None => {
                        error!(
                            request_id = %request_id_for_log,
                            workspace_id = ?workspace_id_for_log,
                            "[JARVIS-TTS-HELPER] generated output path is unsafe",
                        );
                        return Err(VoiceErrorCode::HelperFailed);
                    }
                };
                let file_bytes = std::fs::metadata(&canonical)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if canonical != generated
                    || !canonical.is_file()
                    || file_bytes == 0
                    || file_bytes > MAX_MP3_BYTES
                {
                    error!(
                        request_id = %request_id_for_log,
                        workspace_id = ?workspace_id_for_log,
                        path_matches = canonical == generated,
                        file_exists = canonical.is_file(),
                        file_bytes,
                        max_file_bytes = MAX_MP3_BYTES,
                        "[JARVIS-TTS-HELPER] generated audio failed validation",
                    );
                    return Err(VoiceErrorCode::HelperFailed);
                }
                info!(
                    request_id = %request_id_for_log,
                    workspace_id = ?workspace_id_for_log,
                    file_bytes,
                    "[JARVIS-TTS-HELPER] generated audio validated",
                );
                Ok(canonical)
            }
            .await;
            if result.is_err() {
                warn!(
                    request_id = %request_id_for_log,
                    workspace_id = ?workspace_id_for_log,
                    "[JARVIS-TTS-HELPER] cleaning up failed synthesis output",
                );
                cleanup_temp_file(&output_path);
            }
            result
        })
    }
}

async fn spawn_helper_worker(helper: EdgeHelper) -> Result<HelperSender, VoiceErrorCode> {
    match helper {
        #[cfg(debug_assertions)]
        EdgeHelper::Python(path) => spawn_python_worker(path).await,
        #[cfg(not(debug_assertions))]
        EdgeHelper::Sidecar(app) => spawn_sidecar_worker(app).await,
    }
}

#[cfg(debug_assertions)]
async fn spawn_python_worker(helper_path: PathBuf) -> Result<HelperSender, VoiceErrorCode> {
    // Windows App Execution Aliases can leave `python.exe` pointing at the
    // Microsoft Store stub even when the real launcher is available as `py`.
    // Prefer the Windows launcher, then fall back to the conventional names.
    // This keeps dev mode working without requiring a machine-wide alias.
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
                                Ok(Ok(Some(line))) if line.len() <= MAX_HELPER_OUTPUT_BYTES => {
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
                                        max_response_bytes = MAX_HELPER_OUTPUT_BYTES,
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
async fn spawn_sidecar_worker(app: tauri::AppHandle) -> Result<HelperSender, VoiceErrorCode> {
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
                                        if stdout.len().saturating_add(bytes.len()) > MAX_HELPER_OUTPUT_BYTES {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperResult {
    ok: bool,
    output_path: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoiceInfo {
    pub short_name: String,
    pub locale: String,
    pub gender: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceListResult {
    ok: bool,
    voices: Option<Vec<TtsVoiceInfo>>,
    error: Option<String>,
}

fn helper_error_code(error: Option<&str>) -> VoiceErrorCode {
    match error {
        Some("invalid_text" | "invalid_request") => VoiceErrorCode::InvalidRequest,
        Some("edge_tts_network_failed" | "edge_tts_voice_list_network_failed") => {
            VoiceErrorCode::TtsNetwork
        }
        Some("edge_tts_output_file_failed") => VoiceErrorCode::TtsAudioFileInvalid,
        Some("edge_tts_failed" | "edge_tts_voice_list_failed") => {
            VoiceErrorCode::TtsSynthesisFailed
        }
        _ => VoiceErrorCode::HelperFailed,
    }
}

/// Converts assistant Markdown into deterministic speech text.
///
/// This is intentionally the only normalization boundary in the TTS
/// pipeline. The provider receives the resulting text verbatim and is only
/// responsible for synthesis and playback.
pub fn normalize_for_speech(input: &str, max_chars: usize) -> Option<String> {
    if input.trim().is_empty() || max_chars == 0 {
        return None;
    }

    let visible_lines = input
        .lines()
        .filter(|line| {
            let lowered = line.to_ascii_lowercase();
            !lowered.contains("pending action") && !lowered.contains("diagnostic")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let without_code = strip_code_spans(&visible_lines);
    let without_urls = remove_url_tokens(&extract_markdown_link_text(&without_code));
    let chars = without_urls.chars().collect::<Vec<_>>();
    let mut marked_up = String::with_capacity(without_urls.len());

    for index in 0..chars.len() {
        let character = chars[index];
        if is_apostrophe_between_letters(&chars, index) {
            marked_up.push(character);
        } else if is_speech_delimiter(character) || is_quote_delimiter(character) {
            marked_up.push(' ');
        } else {
            marked_up.push(character);
        }
    }

    let result = collapse_speech_whitespace(&strip_unspeakable_chars(&marked_up));
    if result.is_empty() || !result.chars().any(char::is_alphanumeric) {
        return None;
    }

    truncate_speech_text(&result, max_chars)
}

fn strip_code_spans(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '`' {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let opening_len = backtick_run_length(&chars, index);
        let delimiter_len = opening_len.min(3);
        let mut closing = None;
        let mut search = index + opening_len;
        while search < chars.len() {
            if chars[search] == '`' {
                let run_length = backtick_run_length(&chars, search);
                if run_length >= delimiter_len {
                    closing = Some(search + delimiter_len);
                    break;
                }
                search += run_length;
            } else {
                search += 1;
            }
        }

        // Both fenced blocks and inline code are technical output. Preserve
        // a separator so adjacent natural-language words do not fuse.
        output.push(' ');
        index = closing.unwrap_or(chars.len());
    }

    output
}

fn backtick_run_length(chars: &[char], start: usize) -> usize {
    chars[start..]
        .iter()
        .take_while(|character| **character == '`')
        .count()
}

fn extract_markdown_link_text(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        let (bracket_start, is_image) = if chars[index] == '[' {
            (index, false)
        } else if chars[index] == '!' && chars.get(index + 1) == Some(&'[') {
            (index + 1, true)
        } else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        let Some(close_bracket) = chars[bracket_start + 1..]
            .iter()
            .position(|character| *character == ']')
            .map(|offset| bracket_start + 1 + offset)
        else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        if chars.get(close_bracket + 1) != Some(&'(') {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let Some(close_parenthesis) = matching_parenthesis(&chars, close_bracket + 1) else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        if is_image {
            // The alt text is the only visible/readable part of an image.
            output.push(' ');
        }
        output.extend(chars[bracket_start + 1..close_bracket].iter());
        output.push(' ');
        index = close_parenthesis + 1;
    }

    output
}

fn matching_parenthesis(chars: &[char], opening: usize) -> Option<usize> {
    let mut depth = 0;
    for (index, character) in chars.iter().enumerate().skip(opening) {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn remove_url_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for token in input.split_whitespace() {
        let candidate = token.trim_start_matches(['(', '[', '{', '<']);
        let is_url = candidate.starts_with("http://")
            || candidate.starts_with("https://")
            || candidate.starts_with("www.");
        if !is_url {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push_str(token);
            continue;
        }

        let trailing = token
            .chars()
            .rev()
            .take_while(|character| {
                matches!(
                    character,
                    ')' | ']' | '}' | '.' | ',' | ';' | ':' | '!' | '?' | '…'
                )
            })
            .filter(|character| !matches!(character, ')' | ']' | '}'))
            .collect::<Vec<_>>();
        for character in trailing.iter().rev() {
            output.push(*character);
        }
    }
    output
}

fn is_apostrophe_between_letters(chars: &[char], index: usize) -> bool {
    matches!(chars[index], '\'' | '’')
        && index > 0
        && index + 1 < chars.len()
        && chars[index - 1].is_alphabetic()
        && chars[index + 1].is_alphabetic()
}

fn is_speech_delimiter(character: char) -> bool {
    matches!(
        character,
        '*' | '_'
            | '`'
            | '#'
            | '>'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '~'
            | '|'
            | '/'
            | '\\'
            | '@'
            | '$'
            | '%'
            | '&'
            | '+'
            | '='
            | '^'
    )
}

fn is_quote_delimiter(character: char) -> bool {
    matches!(
        character,
        '\'' | '’' | '"' | '“' | '”' | '„' | '«' | '»' | '‹' | '›'
    )
}

fn collapse_speech_whitespace(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for character in input.chars() {
        if character.is_whitespace() {
            if !output.ends_with(' ') {
                output.push(' ');
            }
        } else if is_prosody_punctuation(character) && output.ends_with(' ') {
            output.pop();
            output.push(character);
        } else {
            output.push(character);
        }
    }
    output.trim().to_string()
}

fn is_prosody_punctuation(character: char) -> bool {
    matches!(character, '.' | ',' | ';' | ':' | '!' | '?' | '…')
}

fn truncate_speech_text(text: &str, max_chars: usize) -> Option<String> {
    if text.chars().count() <= max_chars {
        return Some(text.to_string());
    }

    let prefix = text.chars().take(max_chars).collect::<String>();
    let end = prefix
        .char_indices()
        .rev()
        .find(|(_, character)| is_prosody_punctuation(*character))
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(prefix.len());
    let truncated = prefix[..end].trim();
    if truncated.is_empty() {
        None
    } else {
        Some(truncated.to_string())
    }
}

/// Replaces every char that Edge TTS would verbalize as an emoji/symbol
/// name with a space, then collapses whitespace. Keeps letters, numbers,
/// marks (accents), punctuation and normal whitespace.
fn strip_unspeakable_chars(text: &str) -> String {
    let sanitized: String = text
        .chars()
        .map(|c| if is_speech_safe_char(c) { c } else { ' ' })
        .collect();
    sanitized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_speech_safe_char(c: char) -> bool {
    let cp = c as u32;
    // Format/control codepoints: ZWJ, ZWNJ, soft hyphen, BOM, variation
    // selectors (FE00-FE0F + E0100-E01EF) and private-use glyphs.
    if matches!(
        cp,
        0x200C | 0x200D | 0x00AD | 0xFEFF
            | 0xFE00..=0xFE0F
            | 0xE0100..=0xE01EF
            | 0xE000..=0xF8FF
            // Arrows, math/misc technical, geometric shapes, dingbats,
            // misc symbols+arrows (includes ✅ ✔️ ⚡ 🔺 …).
            | 0x2190..=0x2BFF
            // Emoji, pictographs, flags, enclosed ideographic supplement…
            | 0x1F000..=0x1FAFF
    ) {
        return false;
    }

    c.is_alphanumeric()
        || c.is_whitespace()
        || matches!(
            c,
            '\'' | '’' | '.' | ',' | ';' | ':' | '!' | '?' | '…' | '-' | '–' | '—' | '−' | '×'
        )
}

#[cfg(test)]
fn assert_speech_text(input: &str, expected: &str) {
    let output = normalize_for_speech(input, 800).unwrap_or_default();
    assert_eq!(output, expected, "input: {input:?}");
}

#[cfg(debug_assertions)]
fn spawn_helper_process(path: &Path) -> Result<tokio::process::Child, VoiceErrorCode> {
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
            Ok(mut child) => {
                // The Windows Store execution alias can spawn successfully
                // and terminate immediately. Treat that as a failed candidate
                // so the next launcher (`python`/`python3`) gets a chance.
                match child.try_wait() {
                    Ok(Some(_)) => continue,
                    Ok(None) => return Ok(child),
                    Err(_) => continue,
                }
            }
            Err(_) => continue,
        }
    }
    Err(VoiceErrorCode::HelperFailed)
}

fn temp_audio_path(request_id: &str) -> PathBuf {
    let safe_id: String = request_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(64)
        .collect();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("traflix-jarvis-{safe_id}-{nanos}.mp3"))
}

fn normalize_windows_extended_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn canonical_temp_file(path: &PathBuf) -> Option<PathBuf> {
    let root = normalize_windows_extended_prefix(std::fs::canonicalize(std::env::temp_dir()).ok()?);
    let file = normalize_windows_extended_prefix(std::fs::canonicalize(path).ok()?);
    if !file.is_file() || !file.starts_with(&root) {
        return None;
    }
    Some(file)
}

pub(crate) fn cleanup_temp_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::{assert_speech_text, canonical_temp_file, normalize_for_speech};
    use std::fs;

    #[test]
    fn markdown_code_urls_and_internal_lines_are_removed() {
        let text = "Ciao **Francesco** https://example.com\n```rust\nsecret()\n```\nPending Action: conferma";
        let output = normalize_for_speech(text, 800).unwrap();
        assert_eq!(output, "Ciao Francesco");
    }

    #[test]
    fn markdown_delimiters_are_removed_without_losing_visible_content() {
        assert_speech_text("**codice**.", "codice.");
        assert_speech_text("_corsivo_", "corsivo");
        assert_speech_text("# Titolo", "Titolo");
        assert_speech_text("> Citazione importante.", "Citazione importante.");
        assert_speech_text("Una \"citazione utile\".", "Una citazione utile.");
        assert_speech_text("Parentesi (importante): sì!", "Parentesi importante: sì!");
    }

    #[test]
    fn italian_apostrophes_and_prosody_punctuation_are_preserved() {
        assert_speech_text(
            "L'utente dell'azione, però, è pronto!",
            "L'utente dell'azione, però, è pronto!",
        );
        assert_speech_text(
            "L’utente dell’azione: tutto bene?",
            "L’utente dell’azione: tutto bene?",
        );
    }

    #[test]
    fn markdown_links_keep_visible_text_and_drop_url() {
        assert_speech_text(
            "Leggi [la documentazione](https://example.com/docs).",
            "Leggi la documentazione.",
        );
    }

    #[test]
    fn inline_code_is_omitted_while_surrounding_text_survives() {
        assert_speech_text("Prima `codice_tecnico` dopo.", "Prima dopo.");
        assert_speech_text("Solo `codice_tecnico`", "Solo");
    }
    #[test]
    fn speech_is_bounded_at_sentence_boundary() {
        let output = normalize_for_speech("Prima frase. Seconda frase molto lunga", 20).unwrap();
        assert_eq!(output, "Prima frase.");
    }

    #[test]
    fn emoji_variation_selectors_and_zwj_are_stripped_for_speech() {
        super::assert_speech_text("Ciao 👋 mondo! 🎉🔥", "Ciao mondo!");
        // ZWJ family sequences (man + ZWJ + woman + ZWJ + girl).
        super::assert_speech_text("👨\u{200d}👩\u{200d}👧 famiglia", "famiglia");
        // Variation selector after a dingbat.
        super::assert_speech_text("✔️ Fatto.", "Fatto.");
        // Emoji glued to words get separated, not fused.
        super::assert_speech_text("ciao👋mondo", "ciao mondo");
        // Accents, punctuation and numbers survive.
        super::assert_speech_text("Perché 2×3? – Sì!…", "Perché 2×3? – Sì!…");
        // A message that is only emoji becomes None (nothing to say).
        assert!(normalize_for_speech("🚀🎉🎊", 800).is_none());
    }
    #[test]
    fn empty_speech_is_rejected() {
        assert!(normalize_for_speech("```code```", 800).is_none());
        assert!(normalize_for_speech("https://example.com", 800).is_none());
        assert!(normalize_for_speech("***___###>>>", 800).is_none());
    }

    #[test]
    fn generated_temp_path_is_canonicalized_and_bounded_to_temp_root() {
        let path = std::env::temp_dir().join("traflix-jarvis-path-test.mp3");
        let _ = fs::remove_file(&path);
        fs::write(&path, b"mp3").unwrap();
        let canonical = canonical_temp_file(&path).unwrap();
        let expected = super::normalize_windows_extended_prefix(fs::canonicalize(&path).unwrap());
        assert_eq!(canonical, expected);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cleanup_is_idempotent_for_success_and_all_failure_paths() {
        for suffix in ["success", "helper", "json", "playback", "cancel"] {
            let path = std::env::temp_dir().join(format!("traflix-jarvis-cleanup-{suffix}.mp3"));
            let _ = fs::remove_file(&path);
            fs::write(&path, b"mp3").unwrap();
            super::cleanup_temp_file(&path);
            super::cleanup_temp_file(&path);
            assert!(!path.exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_extended_prefix_is_normalized_before_exact_path_comparison() {
        let normal = std::path::PathBuf::from(r"C:\Temp\jarvis.mp3");
        let extended = std::path::PathBuf::from(r"\\?\C:\Temp\jarvis.mp3");
        assert_eq!(super::normalize_windows_extended_prefix(extended), normal);
    }
}
