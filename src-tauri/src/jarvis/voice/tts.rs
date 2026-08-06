use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::types::{VoiceErrorCode, MAX_MP3_BYTES};

const MAX_HELPER_OUTPUT_BYTES: usize = 64 * 1024;
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub type TtsFuture = Pin<Box<dyn Future<Output = Result<PathBuf, VoiceErrorCode>> + Send>>;

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
    pub helper_path: PathBuf,
}

impl EdgeTextToSpeechProvider {
    pub fn new(helper_path: PathBuf) -> Self {
        Self { helper_path }
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
        let helper_path = self.helper_path.clone();
        Box::pin(async move {
            let text =
                sanitize_for_speech(&text, max_chars).ok_or(VoiceErrorCode::InvalidRequest)?;
            let output_path = temp_audio_path(&request_id);
            let result = async {
                let mut child = helper_command(helper_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| VoiceErrorCode::HelperFailed)?;
                let payload = serde_json::json!({ "requestId": request_id, "text": text, "voice": voice, "rate": rate, "volume": volume, "pitch": pitch, "outputPath": output_path });
                if let Some(mut stdin) = child.stdin.take() {
                    if stdin.write_all(payload.to_string().as_bytes()).await.is_err() {
                        let _ = child.kill().await;
                        return Err(VoiceErrorCode::HelperFailed);
                    }
                }
                let Some(stdout) = child.stdout.take() else {
                    let _ = child.kill().await;
                    return Err(VoiceErrorCode::HelperFailed);
                };
                let status = tokio::select! {
                    _ = cancellation.cancelled() => { let _ = child.kill().await; return Err(VoiceErrorCode::Cancelled); },
                    result = tokio::time::timeout(HELPER_TIMEOUT, child.wait()) => {
                        match result {
                            Ok(Ok(status)) => status,
                            _ => { let _ = child.kill().await; return Err(VoiceErrorCode::HelperFailed); }
                        }
                    }
                };
                let mut stdout_bytes = Vec::new();
                let read_result = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    stdout.take((MAX_HELPER_OUTPUT_BYTES + 1) as u64).read_to_end(&mut stdout_bytes),
                ).await;
                read_result.map_err(|_| VoiceErrorCode::HelperFailed)?.map_err(|_| VoiceErrorCode::HelperFailed)?;
                if !status.success() || stdout_bytes.len() > MAX_HELPER_OUTPUT_BYTES {
                    return Err(VoiceErrorCode::HelperFailed);
                }
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
            }.await;
            if result.is_err() {
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
        assert_eq!(canonical, fs::canonicalize(&path).unwrap());
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
