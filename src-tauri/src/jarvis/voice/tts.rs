use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::types::VoiceErrorCode;

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
            let python = if cfg!(windows) { "python" } else { "python3" };
            let mut child = Command::new(python)
                .arg("-u")
                .arg(helper_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| VoiceErrorCode::HelperFailed)?;
            let payload = serde_json::json!({ "requestId": request_id, "text": text, "voice": voice, "rate": rate, "volume": volume, "pitch": pitch, "outputPath": output_path });
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(payload.to_string().as_bytes())
                    .await
                    .map_err(|_| VoiceErrorCode::HelperFailed)?;
            }
            let mut stdout = child.stdout.take().ok_or(VoiceErrorCode::HelperFailed)?;
            let status = tokio::select! {
                _ = cancellation.cancelled() => { let _ = child.kill().await; return Err(VoiceErrorCode::Cancelled); },
                result = child.wait() => result.map_err(|_| VoiceErrorCode::HelperFailed)?
            };
            let mut stdout_bytes = Vec::new();
            stdout
                .read_to_end(&mut stdout_bytes)
                .await
                .map_err(|_| VoiceErrorCode::HelperFailed)?;
            if !status.success() {
                return Err(VoiceErrorCode::HelperFailed);
            }
            let result: HelperResult =
                serde_json::from_slice(&stdout_bytes).map_err(|_| VoiceErrorCode::HelperFailed)?;
            if !result.ok {
                return Err(VoiceErrorCode::HelperFailed);
            }
            let path = PathBuf::from(result.output_path.unwrap_or_default());
            let canonical = path
                .canonicalize()
                .map_err(|_| VoiceErrorCode::HelperFailed)?;
            if !canonical.starts_with(std::env::temp_dir()) || !canonical.is_file() {
                return Err(VoiceErrorCode::HelperFailed);
            }
            Ok(canonical)
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

fn temp_audio_path(request_id: &str) -> String {
    let safe_id: String = request_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(64)
        .collect();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir()
        .join(format!("traflix-jarvis-{safe_id}-{nanos}.mp3"))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::sanitize_for_speech;

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
}
