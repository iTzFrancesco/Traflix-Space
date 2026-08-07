use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

use super::types::{VoiceErrorCode, MAX_MP3_BYTES};

const MAX_HELPER_OUTPUT_BYTES: usize = 64 * 1024;
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const HELPER_QUEUE_DEPTH: usize = 4;

pub type TtsFuture = Pin<Box<dyn Future<Output = Result<PathBuf, VoiceErrorCode>> + Send>>;

type HelperSender = mpsc::Sender<HelperRequest>;

enum HelperRequest {
    Run {
        payload: String,
        cancellation: CancellationToken,
        response: oneshot::Sender<Result<Vec<u8>, VoiceErrorCode>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

pub trait TextToSpeechProvider: Send + Sync {
    fn speak(
        &self,
        request_id: String,
        text: String,
        voice: String,
        rate: String,
        volume: String,
        pitch: String,
        max_chars: usize,
        cancellation: CancellationToken,
    ) -> TtsFuture;
}

#[derive(Clone)]
pub struct EdgeTextToSpeechProvider {
    helper: EdgeHelper,
    worker: Arc<AsyncMutex<Option<HelperSender>>>,
}

#[derive(Clone)]
enum EdgeHelper {
    Python(PathBuf),
    Sidecar(tauri::AppHandle),
}

impl EdgeTextToSpeechProvider {
    pub fn new(helper_path: PathBuf) -> Self {
        Self {
            helper: EdgeHelper::Python(helper_path),
            worker: Arc::new(AsyncMutex::new(None)),
        }
    }

    pub fn debug(helper_path: PathBuf) -> Self {
        Self::new(helper_path)
    }

    pub fn release(app: tauri::AppHandle) -> Self {
        Self {
            helper: EdgeHelper::Sidecar(app),
            worker: Arc::new(AsyncMutex::new(None)),
        }
    }

    pub async fn prewarm(&self) -> Result<(), VoiceErrorCode> {
        let bytes = self
            .run_helper(
                r#"{"action":"ping"}"#.to_string(),
                CancellationToken::new(),
            )
            .await?;
        let result: HelperResult =
            serde_json::from_slice(&bytes).map_err(|_| VoiceErrorCode::HelperFailed)?;
        if result.ok {
            Ok(())
        } else {
            Err(VoiceErrorCode::HelperFailed)
        }
    }

    pub async fn shutdown(&self) {
        let sender = self.worker.lock().await.take();
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

    async fn worker_sender(&self) -> Result<HelperSender, VoiceErrorCode> {
        let mut worker = self.worker.lock().await;
        if let Some(sender) = worker.as_ref() {
            if !sender.is_closed() {
                return Ok(sender.clone());
            }
        }
        let sender = spawn_helper_worker(self.helper.clone()).await?;
        *worker = Some(sender.clone());
        Ok(sender)
    }

    async fn reset_worker(&self) {
        self.worker.lock().await.take();
    }

    async fn run_helper(
        &self,
        payload: String,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, VoiceErrorCode> {
        for attempt in 0..2 {
            if cancellation.is_cancelled() {
                return Err(VoiceErrorCode::Cancelled);
            }
            let sender = self.worker_sender().await?;
            let (response, result) = oneshot::channel();
            if sender
                .send(HelperRequest::Run {
                    payload: payload.clone(),
                    cancellation: cancellation.clone(),
                    response,
                })
                .await
                .is_err()
            {
                self.reset_worker().await;
                if attempt == 0 {
                    continue;
                }
                return Err(VoiceErrorCode::HelperFailed);
            }
            match result.await {
                Ok(Ok(bytes)) => return Ok(bytes),
                Ok(Err(VoiceErrorCode::Cancelled)) => return Err(VoiceErrorCode::Cancelled),
                Ok(Err(_)) | Err(_) if attempt == 0 => {
                    self.reset_worker().await;
                }
                Ok(Err(code)) => return Err(code),
                Err(_) => return Err(VoiceErrorCode::HelperFailed),
            }
        }
        Err(VoiceErrorCode::HelperFailed)
    }

    pub async fn list_voices(&self) -> Result<Vec<TtsVoiceInfo>, VoiceErrorCode> {
        let bytes = self
            .run_helper(
                r#"{"action":"listVoices"}"#.to_string(),
                CancellationToken::new(),
            )
            .await?;
        let result: VoiceListResult =
            serde_json::from_slice(&bytes).map_err(|_| VoiceErrorCode::HelperFailed)?;
        if !result.ok {
            return Err(VoiceErrorCode::HelperFailed);
        }
        Ok(result.voices.unwrap_or_default())
    }
}

impl TextToSpeechProvider for EdgeTextToSpeechProvider {
    fn speak(
        &self,
        request_id: String,
        text: String,
        voice: String,
        rate: String,
        volume: String,
        pitch: String,
        max_chars: usize,
        cancellation: CancellationToken,
    ) -> TtsFuture {
        let provider = self.clone();
        Box::pin(async move {
            let text =
                sanitize_for_speech(&text, max_chars).ok_or(VoiceErrorCode::InvalidRequest)?;
            let output_path = temp_audio_path(&request_id);
            let result = async {
                let payload = serde_json::json!({ "requestId": request_id, "text": text, "voice": voice, "rate": rate, "volume": volume, "pitch": pitch, "outputPath": output_path }).to_string();
                let stdout_bytes = provider.run_helper(payload, cancellation.clone()).await?;
                let result: HelperResult =
                    serde_json::from_slice(&stdout_bytes).map_err(|_| VoiceErrorCode::HelperFailed)?;
                if !result.ok {
                    return Err(VoiceErrorCode::HelperFailed);
                }
                let returned = PathBuf::from(result.output_path.unwrap_or_default());
                let canonical = canonical_temp_file(&returned).ok_or(VoiceErrorCode::HelperFailed)?;
                let generated = canonical_temp_file(&output_path).ok_or(VoiceErrorCode::HelperFailed)?;
                if canonical != generated
                    || !canonical.is_file()
                    || std::fs::metadata(&canonical)
                        .map(|metadata| metadata.len() == 0 || metadata.len() > MAX_MP3_BYTES)
                        .unwrap_or(true)
                {
                    return Err(VoiceErrorCode::HelperFailed);
                }
                Ok(canonical)
            }
            .await;
            if result.is_err() {
                cleanup_temp_file(&output_path);
            }
            result
        })
    }
}

async fn spawn_helper_worker(helper: EdgeHelper) -> Result<HelperSender, VoiceErrorCode> {
    match helper {
        EdgeHelper::Python(path) => spawn_python_worker(path).await,
        EdgeHelper::Sidecar(app) => spawn_sidecar_worker(app).await,
    }
}

async fn spawn_python_worker(helper_path: PathBuf) -> Result<HelperSender, VoiceErrorCode> {
    let mut child = helper_command(helper_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| VoiceErrorCode::HelperFailed)?;
    let mut stdin = child.stdin.take().ok_or(VoiceErrorCode::HelperFailed)?;
    let stdout = child.stdout.take().ok_or(VoiceErrorCode::HelperFailed)?;
    let mut lines = BufReader::new(stdout).lines();
    let (sender, mut requests) = mpsc::channel::<HelperRequest>(HELPER_QUEUE_DEPTH);

    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                HelperRequest::Run {
                    payload,
                    cancellation,
                    response,
                } => {
                    if stdin.write_all(payload.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        let _ = response.send(Err(VoiceErrorCode::HelperFailed));
                        break;
                    }
                    let result = tokio::select! {
                        _ = cancellation.cancelled() => {
                            let _ = child.kill().await;
                            Err(VoiceErrorCode::Cancelled)
                        }
                        result = tokio::time::timeout(HELPER_TIMEOUT, lines.next_line()) => {
                            match result {
                                Ok(Ok(Some(line))) if line.len() <= MAX_HELPER_OUTPUT_BYTES => Ok(line.into_bytes()),
                                _ => {
                                    let _ = child.kill().await;
                                    Err(VoiceErrorCode::HelperFailed)
                                }
                            }
                        }
                    };
                    let fatal = result.is_err();
                    let _ = response.send(result);
                    if fatal {
                        break;
                    }
                }
                HelperRequest::Shutdown { response } => {
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

async fn spawn_sidecar_worker(app: tauri::AppHandle) -> Result<HelperSender, VoiceErrorCode> {
    let command = app
        .shell()
        .sidecar("jarvis-edge-tts")
        .map_err(|_| VoiceErrorCode::HelperFailed)?
        .set_raw_out(true);
    let (mut events, child) = command.spawn().map_err(|_| VoiceErrorCode::HelperFailed)?;
    let mut child = Some(child);
    let (sender, mut requests) = mpsc::channel::<HelperRequest>(HELPER_QUEUE_DEPTH);

    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            match request {
                HelperRequest::Run {
                    payload,
                    cancellation,
                    response,
                } => {
                    let Some(running) = child.as_mut() else {
                        let _ = response.send(Err(VoiceErrorCode::HelperFailed));
                        break;
                    };
                    if running.write(payload.as_bytes()).is_err()
                        || running.write(b"\n").is_err()
                    {
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
                                            return Ok(stdout);
                                        }
                                    }
                                    Some(CommandEvent::Terminated(_)) => {
                                        let _ = child.take();
                                        return Err(VoiceErrorCode::HelperFailed);
                                    }
                                    Some(CommandEvent::Error(_)) => {
                                        if let Some(running) = child.take() { let _ = running.kill(); }
                                        return Err(VoiceErrorCode::HelperFailed);
                                    }
                                    Some(CommandEvent::Stderr(_)) => {}
                                    None => {
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
                        Err(_) => {
                            if let Some(running) = child.take() {
                                let _ = running.kill();
                            }
                            Err(VoiceErrorCode::HelperFailed)
                        }
                    };
                    let fatal = result.is_err();
                    let _ = response.send(result);
                    if fatal {
                        break;
                    }
                }
                HelperRequest::Shutdown { response } => {
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
}

pub fn sanitize_for_speech(input: &str, max_chars: usize) -> Option<String> {
    let mut text = input.to_string();
    let mut cleaned = String::with_capacity(text.len());
    let mut in_code = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code
            || line.to_ascii_lowercase().contains("pending action")
            || line.to_ascii_lowercase().contains("diagnostic")
        {
            continue;
        }
        cleaned.push_str(line);
        cleaned.push('\n');
    }
    text = cleaned.replace("[", "").replace("](", " ").replace(")", "");
    let mut result = String::new();
    for token in text.split_whitespace() {
        if token.starts_with("http://") || token.starts_with("https://") {
            continue;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(token.trim_matches('*').trim_matches('`'));
    }
    let result = result.trim().to_string();
    if result.is_empty() {
        return None;
    }
    if result.chars().count() <= max_chars {
        return Some(result);
    }
    let mut end = result
        .char_indices()
        .take_while(|(index, _)| *index < max_chars)
        .map(|(index, _)| index)
        .last()
        .unwrap_or(0);
    if let Some((index, _)) = result[..end]
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '.' | '!' | '?' | ':' | ';'))
    {
        end = index
            + result[index..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
    }
    let truncated = result[..end].trim();
    if truncated.is_empty() {
        None
    } else {
        Some(truncated.to_string())
    }
}

fn helper_command(path: PathBuf) -> Command {
    if path.extension().and_then(|value| value.to_str()) == Some("exe") {
        Command::new(path)
    } else {
        let mut command = Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.arg("-u").arg(path);
        command
    }
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
    use super::{canonical_temp_file, sanitize_for_speech};
    use std::fs;

    #[test]
    fn markdown_code_urls_and_internal_lines_are_removed() {
        let text = "Ciao **Francesco** https://example.com\n```rust\nsecret()\n```\nPending Action: conferma";
        let output = sanitize_for_speech(text, 800).unwrap();
        assert_eq!(output, "Ciao Francesco");
    }
    #[test]
    fn speech_is_bounded_at_sentence_boundary() {
        let output = sanitize_for_speech("Prima frase. Seconda frase molto lunga", 20).unwrap();
        assert_eq!(output, "Prima frase.");
    }
    #[test]
    fn empty_speech_is_rejected() {
        assert!(sanitize_for_speech("```code```", 800).is_none());
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
