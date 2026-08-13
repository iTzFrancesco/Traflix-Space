use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::{header::CONTENT_TYPE, Client, StatusCode};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::types::{VoiceErrorCode, GROQ_STT_MODEL, MAX_WAV_BYTES};

const GROQ_ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_BOUNDARY: &str = "------------------------traflix-space-jarvis";
const GROQ_CONTENT_TYPE: &str =
    "multipart/form-data; boundary=------------------------traflix-space-jarvis";
const GROQ_PROMPT: &str =
    "Traflix Space, Jarvis, Codex, OpenCode, Pi, Freebuff, Tauri, ConPTY, workspace";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

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

#[derive(Clone)]
struct CachedGroqProvider {
    api_key: String,
    provider: GroqSpeechToTextProvider,
}

static RUNTIME_PROVIDER: OnceLock<Mutex<Option<CachedGroqProvider>>> = OnceLock::new();

impl GroqSpeechToTextProvider {
    pub fn from_environment() -> Result<Self, VoiceErrorCode> {
        // Use the same process/user/.env resolver as Settings. This matters
        // on Windows, where the user environment is not injected into an
        // already-running Tauri process automatically.
        let api_key =
            crate::settings::secrets::read_secret_env(crate::settings::secrets::GROQ_API_KEY_ENV);
        let Some(api_key) = api_key else {
            return Self::new(GROQ_ENDPOINT, None);
        };

        // Keep one reqwest client alive across voice turns. Besides avoiding
        // per-turn client construction, this lets reqwest reuse the Groq
        // keep-alive connection when the service/network permits it.
        let cache = RUNTIME_PROVIDER.get_or_init(|| Mutex::new(None));
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.as_ref() {
            if cached.api_key == api_key {
                return Ok(cached.provider.clone());
            }
        }
        let provider = Self::new(GROQ_ENDPOINT, Some(api_key.clone()))?;
        *cache = Some(CachedGroqProvider {
            api_key,
            provider: provider.clone(),
        });
        Ok(provider)
    }

    pub fn new(
        endpoint: impl Into<String>,
        api_key: Option<String>,
    ) -> Result<Self, VoiceErrorCode> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(1)
            .tcp_nodelay(true)
            .build()
            .map_err(|_| VoiceErrorCode::Transport)?;
        Ok(Self {
            client,
            endpoint: endpoint.into(),
            api_key: api_key.map(|key| key.trim().to_string()),
        })
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

            let language = normalized_language(&language);
            let body = build_groq_multipart(&wav, &language);
            let started = Instant::now();
            let request = this
                .client
                .post(&this.endpoint)
                .bearer_auth(this.api_key.as_deref().unwrap_or_default())
                .header(CONTENT_TYPE, GROQ_CONTENT_TYPE)
                .body(body);
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(VoiceErrorCode::Cancelled),
                result = request.send() => result.map_err(classify_transport)?
            };
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(VoiceErrorCode::InvalidResponse);
            }
            let body = tokio::select! {
                _ = cancellation.cancelled() => return Err(VoiceErrorCode::Cancelled),
                result = response.bytes() => result.map_err(classify_transport)?
            };
            if body.len() > MAX_RESPONSE_BYTES {
                return Err(VoiceErrorCode::InvalidResponse);
            }
            if !status.is_success() {
                return Err(classify_status(status));
            }

            // Groq's `text` response is already the only value Jarvis needs.
            // Avoid JSON allocation/parsing on every successful voice turn.
            let text = std::str::from_utf8(&body)
                .map_err(|_| VoiceErrorCode::InvalidResponse)?
                .trim()
                .to_string();
            if text.is_empty() {
                return Err(VoiceErrorCode::InvalidResponse);
            }
            debug!(
                wav_bytes = wav.len(),
                elapsed_ms = started.elapsed().as_millis() as u64,
                "Groq STT round-trip completed"
            );
            Ok(text)
        })
    }
}

fn normalized_language(language: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty()
        || language.chars().any(|ch| ch.is_control())
        || trimmed.len() > 16
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        "it".to_string()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

fn push_field(body: &mut Vec<u8>, name: &str, value: &str) {
    body.extend_from_slice(b"--");
    body.extend_from_slice(GROQ_BOUNDARY.as_bytes());
    body.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"");
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(b"\"\r\n\r\n");
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

fn build_groq_multipart(wav: &[u8], language: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len().saturating_add(768));
    push_field(&mut body, "model", GROQ_STT_MODEL);
    push_field(&mut body, "language", language);
    push_field(&mut body, "response_format", "text");
    push_field(&mut body, "temperature", "0");
    push_field(&mut body, "prompt", GROQ_PROMPT);
    body.extend_from_slice(b"--");
    body.extend_from_slice(GROQ_BOUNDARY.as_bytes());
    body.extend_from_slice(
        b"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n",
    );
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n--");
    body.extend_from_slice(GROQ_BOUNDARY.as_bytes());
    body.extend_from_slice(b"--\r\n");
    body
}

fn classify_status(status: StatusCode) -> VoiceErrorCode {
    warn!(stt_status = %status, "Groq STT request rejected by HTTP status");
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
    warn!(
        stt_error = %error,
        stt_timeout = error.is_timeout(),
        "Groq STT transport failure"
    );
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
                let response = format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn missing_key_is_not_configured_without_network() {
        let provider = GroqSpeechToTextProvider::new("http://127.0.0.1:1", None).unwrap();
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
        let endpoint = server("ciao", 200, requests.clone()).await;
        let provider = GroqSpeechToTextProvider::new(endpoint, Some("test-secret".into())).unwrap();
        let result = provider
            .transcribe(vec![0; 128], "it".into(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result, "ciao");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(GROQ_STT_MODEL, "whisper-large-v3-turbo");
    }

    #[test]
    fn raw_multipart_contains_fixed_fields_and_audio_without_reencoding() {
        let wav = b"RIFFtiny-wave";
        let payload = build_groq_multipart(wav, "it");
        let text = String::from_utf8_lossy(&payload);
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-large-v3-turbo"));
        assert!(text.contains("name=\"language\"\r\n\r\nit"));
        assert!(text.contains("name=\"response_format\"\r\n\r\ntext"));
        assert!(payload.windows(wav.len()).any(|window| window == wav));
    }

    #[test]
    fn language_is_bounded_before_entering_multipart_headers() {
        assert_eq!(normalized_language("IT"), "it");
        assert_eq!(normalized_language("\r\nmalicious"), "it");
        assert_eq!(normalized_language(""), "it");
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
