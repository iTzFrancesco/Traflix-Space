use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{multipart, Client, StatusCode};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::types::{VoiceErrorCode, GROQ_STT_MODEL, MAX_WAV_BYTES};

pub type SttFuture = Pin<Box<dyn Future<Output = Result<String, VoiceErrorCode>> + Send>>;

pub trait SpeechToTextProvider: Send + Sync {
    fn configured(&self) -> bool;
    fn transcribe(
        &self,
        wav: Vec<u8>,
        language: String,
        cancellation: CancellationToken,
    ) -> SttFuture;
}

#[derive(Clone)]
pub struct GroqSpeechToTextProvider {
    client: Client,
    endpoint: String,
    api_key: Option<String>,
}

impl GroqSpeechToTextProvider {
    pub fn from_environment() -> Result<Self, VoiceErrorCode> {
        let api_key = std::env::var("GROQ_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty());
        Ok(Self::new(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            api_key,
        ))
    }

    pub fn new(endpoint: impl Into<String>, api_key: Option<String>) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("voice HTTP client");
        Self {
            client,
            endpoint: endpoint.into(),
            api_key,
        }
    }
}

impl SpeechToTextProvider for GroqSpeechToTextProvider {
    fn configured(&self) -> bool {
        self.api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty())
    }

    fn transcribe(
        &self,
        wav: Vec<u8>,
        language: String,
        cancellation: CancellationToken,
    ) -> SttFuture {
        let this = self.clone();
        Box::pin(async move {
            if !this.configured() {
                return Err(VoiceErrorCode::ProviderNotConfigured);
            }
            if wav.is_empty() || wav.len() > MAX_WAV_BYTES {
                return Err(VoiceErrorCode::AudioTooLarge);
            }
            let file = multipart::Part::bytes(wav)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|_| VoiceErrorCode::InvalidRequest)?;
            let form = multipart::Form::new()
                .part("file", file)
                .text("model", GROQ_STT_MODEL)
                .text("language", if language.trim().is_empty() { "it".into() } else { language })
                .text("response_format", "json")
                .text("temperature", "0")
                .text("prompt", "Traflix Space, Jarvis, Codex, OpenCode, Pi, Freebuff, Tauri, ConPTY, workspace");
            let request = this
                .client
                .post(&this.endpoint)
                .bearer_auth(this.api_key.as_deref().unwrap_or_default())
                .multipart(form);
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(VoiceErrorCode::Cancelled),
                result = request.send() => result.map_err(classify_transport)?
            };
            let status = response.status();
            let mut stream = response.bytes_stream();
            let mut body = Vec::new();
            loop {
                let next = tokio::select! {
                    _ = cancellation.cancelled() => return Err(VoiceErrorCode::Cancelled),
                    next = stream.next() => next
                };
                let Some(chunk) = next else {
                    break;
                };
                let chunk = chunk.map_err(classify_transport)?;
                if body.len().saturating_add(chunk.len()) > 64 * 1024 {
                    return Err(VoiceErrorCode::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            if !status.is_success() {
                return Err(classify_status(status));
            }
            let payload: GroqTranscriptionResponse =
                serde_json::from_slice(&body).map_err(|_| VoiceErrorCode::InvalidResponse)?;
            let text = payload.text.trim().to_string();
            if text.is_empty() {
                return Err(VoiceErrorCode::InvalidResponse);
            }
            Ok(text)
        })
    }
}

#[derive(Debug, Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
}

fn classify_status(status: StatusCode) -> VoiceErrorCode {
    match status {
        StatusCode::UNAUTHORIZED => VoiceErrorCode::AuthFailed,
        StatusCode::FORBIDDEN => VoiceErrorCode::Forbidden,
        StatusCode::TOO_MANY_REQUESTS => VoiceErrorCode::RateLimited,
        StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST => VoiceErrorCode::ModelUnavailable,
        status if status.is_server_error() => VoiceErrorCode::Transport,
        _ => VoiceErrorCode::InvalidResponse,
    }
}

fn classify_transport(error: reqwest::Error) -> VoiceErrorCode {
    if error.is_timeout() {
        VoiceErrorCode::Timeout
    } else {
        VoiceErrorCode::Transport
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn server(body: &'static str, status: u16, requests: Arc<AtomicUsize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                requests.fetch_add(1, Ordering::SeqCst);
                let mut buffer = vec![0_u8; 32 * 1024];
                let _ = socket.read(&mut buffer).await;
                let response = format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn missing_key_is_not_configured_without_network() {
        let provider = GroqSpeechToTextProvider::new("http://127.0.0.1:1", None);
        assert!(!provider.configured());
        assert_eq!(
            provider
                .transcribe(vec![1], "it".into(), CancellationToken::new())
                .await,
            Err(VoiceErrorCode::ProviderNotConfigured)
        );
    }

    #[tokio::test]
    async fn multipart_uses_only_turbo_model() {
        let requests = Arc::new(AtomicUsize::new(0));
        let endpoint = server(r#"{"text":"ciao"}"#, 200, requests.clone()).await;
        let provider = GroqSpeechToTextProvider::new(endpoint, Some("test-secret".into()));
        let result = provider
            .transcribe(vec![0; 128], "it".into(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result, "ciao");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(GROQ_STT_MODEL, "whisper-large-v3-turbo");
    }

    #[test]
    fn status_errors_are_typed() {
        assert_eq!(
            classify_status(StatusCode::UNAUTHORIZED),
            VoiceErrorCode::AuthFailed
        );
        assert_eq!(
            classify_status(StatusCode::FORBIDDEN),
            VoiceErrorCode::Forbidden
        );
        assert_eq!(
            classify_status(StatusCode::TOO_MANY_REQUESTS),
            VoiceErrorCode::RateLimited
        );
    }
}
