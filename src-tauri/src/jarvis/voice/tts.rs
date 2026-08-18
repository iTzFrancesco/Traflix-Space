use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use super::types::{VoiceErrorCode, MAX_MP3_BYTES};

#[path = "tts_files.rs"]
mod files;
#[path = "tts_text.rs"]
mod text;
#[path = "tts_worker.rs"]
mod tts_worker;

pub(crate) use files::cleanup_temp_file;
use files::{canonical_temp_file, temp_audio_path};
pub use text::normalize_for_speech;
use tts_worker::spawn_helper_worker;

const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const HELPER_QUEUE_DEPTH: usize = 4;
const HELPER_OUTPUT_LIMIT: usize = 64 * 1024;

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
                let payload = serde_json::json!({
                    "requestId": request_id,
                    "text": text,
                    "voice": voice,
                    "rate": rate,
                    "volume": volume,
                    "pitch": pitch,
                    "outputPath": output_path,
                })
                .to_string();
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
