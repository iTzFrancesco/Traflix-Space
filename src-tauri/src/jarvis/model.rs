use crate::settings::store::{ModelProvider, TextModelSettings};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const OPENCODE_ZEN_ENDPOINT: &str = "https://opencode.ai/zen/v1/chat/completions";
pub const OPENCODE_ZEN_API_KEY_ENV: &str = "OPENCODE_ZEN_API_KEY";
pub const MAX_MODEL_PAYLOAD_BYTES: usize = 96 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 512 * 1024;
const PRIMARY_BREAKER: Duration = Duration::from_secs(12 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ModelToolCall>>,
}

impl ModelMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_call_id: None,
            tool_calls: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ModelFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelToolDefinition {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ModelFunctionDefinition,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelResponse {
    pub content: String,
    pub tool_calls: Vec<ModelToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FallbackReason {
    PrimaryModelUnavailable,
    Timeout,
    Transport,
    RateLimited,
    Server,
    InvalidResponse,
}

impl FallbackReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PrimaryModelUnavailable => "primary_model_unavailable",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::RateLimited => "rate_limited",
            Self::Server => "server_error",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    ConsentRequired,
    NotConfigured,
    AuthFailed,
    Forbidden,
    RateLimited,
    Server,
    Timeout,
    Transport,
    ModelUnavailable,
    InvalidResponse,
    PayloadTooLarge,
    InvalidPayload,
    Cancelled,
}

impl ModelError {
    fn fallback_reason(&self) -> Option<FallbackReason> {
        match self {
            Self::ModelUnavailable => Some(FallbackReason::PrimaryModelUnavailable),
            Self::RateLimited => Some(FallbackReason::RateLimited),
            Self::Server => Some(FallbackReason::Server),
            Self::Timeout => Some(FallbackReason::Timeout),
            Self::Transport => Some(FallbackReason::Transport),
            Self::InvalidResponse => Some(FallbackReason::InvalidResponse),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub settings: TextModelSettings,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ModelToolDefinition>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelCompletion {
    pub response: ModelResponse,
    pub provider: ModelProvider,
    pub model_used: String,
    pub primary_model: String,
    pub fallback_used: bool,
    pub fallback_reason: Option<FallbackReason>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ModelProvider,
    pub primary_model: String,
    pub fallback_model: String,
    pub configured: bool,
    pub fallback_enabled: bool,
    pub privacy_consent: bool,
    pub privacy_consent_at: Option<String>,
    pub primary_model_available: bool,
    pub circuit_breaker_until: Option<String>,
    pub circuit_breaker_reason: Option<String>,
}

pub trait JarvisModelProvider: Send + Sync {
    fn status(&self, settings: &TextModelSettings) -> ProviderStatus;
    fn complete(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ModelCompletion, ModelError>> + Send>>;
}

#[derive(Clone)]
pub struct OpenCodeZenProvider {
    client: Client,
    endpoint: String,
    credential_override: Option<Option<String>>,
    breaker: std::sync::Arc<Mutex<Option<BreakerState>>>,
}

#[derive(Debug, Clone)]
struct BreakerState {
    until: Instant,
    reason: FallbackReason,
}

impl Default for OpenCodeZenProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenCodeZenProvider {
    pub fn new() -> Self {
        Self::with_endpoint(
            OPENCODE_ZEN_ENDPOINT.to_string(),
            None,
            Duration::from_secs(90),
        )
    }

    fn with_endpoint(
        endpoint: String,
        credential_override: Option<Option<String>>,
        timeout: Duration,
    ) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            endpoint,
            credential_override,
            breaker: std::sync::Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn for_test(endpoint: String, credential: Option<&str>) -> Self {
        Self::with_endpoint(
            endpoint,
            Some(credential.map(str::to_string)),
            Duration::from_secs(2),
        )
    }

    #[cfg(test)]
    fn for_timeout_test(endpoint: String) -> Self {
        Self::with_endpoint(
            endpoint,
            Some(Some("test-key".to_string())),
            Duration::from_millis(20),
        )
    }

    fn credential(&self) -> Option<String> {
        match &self.credential_override {
            Some(value) => value.clone(),
            None => std::env::var(OPENCODE_ZEN_API_KEY_ENV)
                .ok()
                .filter(|value| !value.trim().is_empty()),
        }
    }

    fn breaker_reason(&self) -> Option<FallbackReason> {
        let Ok(mut breaker) = self.breaker.lock() else {
            return None;
        };
        let Some(state) = breaker.as_ref() else {
            return None;
        };
        if state.until <= Instant::now() {
            *breaker = None;
            return None;
        }
        Some(state.reason.clone())
    }

    fn open_breaker(&self, reason: FallbackReason) {
        if let Ok(mut breaker) = self.breaker.lock() {
            *breaker = Some(BreakerState {
                until: Instant::now() + PRIMARY_BREAKER,
                reason,
            });
        }
    }

    async fn request_once(
        &self,
        model: &str,
        messages: Vec<ModelMessage>,
        tools: Vec<ModelToolDefinition>,
        cancellation: CancellationToken,
    ) -> Result<ModelResponse, ModelError> {
        let Some(api_key) = self.credential() else {
            return Err(ModelError::NotConfigured);
        };
        let body = build_payload(model, messages, tools)?;
        let request = self
            .client
            .post(&self.endpoint)
            .bearer_auth(api_key)
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            result = request => result.map_err(classify_transport)?
        };
        let status = response.status();
        let payload = read_bounded_response(response, cancellation.clone()).await?;
        if !status.is_success() {
            return Err(classify_http(status, &payload));
        }
        let parsed = serde_json::from_slice::<ChatResponse>(&payload)
            .map_err(|_| ModelError::InvalidResponse)?;
        let choice = parsed
            .choices
            .into_iter()
            .next()
            .ok_or(ModelError::InvalidResponse)?;
        let tool_calls = choice.message.tool_calls.unwrap_or_default();
        if choice.message.content.is_none() && tool_calls.is_empty() {
            return Err(ModelError::InvalidResponse);
        }
        Ok(ModelResponse {
            content: choice.message.content.unwrap_or_default(),
            tool_calls,
        })
    }

    async fn complete_inner(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Result<ModelCompletion, ModelError> {
        if !request.settings.privacy_consent
            || request
                .settings
                .privacy_consent_at
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty)
        {
            return Err(ModelError::ConsentRequired);
        }
        if self.credential().is_none() {
            return Err(ModelError::NotConfigured);
        }
        let primary = request.settings.primary_model.trim().to_string();
        if primary.is_empty() {
            return Err(ModelError::InvalidPayload);
        }
        let primary_reason = self.breaker_reason();
        let primary_result = if primary_reason.is_some() {
            Err(ModelError::ModelUnavailable)
        } else {
            self.request_once(
                &primary,
                request.messages.clone(),
                request.tools.clone(),
                cancellation.clone(),
            )
            .await
        };
        match primary_result {
            Ok(response) => Ok(ModelCompletion {
                response,
                provider: ModelProvider::OpenCodeZen,
                model_used: primary.clone(),
                primary_model: primary,
                fallback_used: false,
                fallback_reason: None,
            }),
            Err(error) => {
                if error == ModelError::Cancelled {
                    return Err(error);
                }
                let Some(reason) = primary_reason.or_else(|| error.fallback_reason()) else {
                    return Err(error);
                };
                if error == ModelError::ModelUnavailable {
                    self.open_breaker(reason.clone());
                }
                if !request.settings.fallback_enabled
                    || request.settings.fallback_model.trim().is_empty()
                {
                    return Err(error);
                }
                let fallback = request.settings.fallback_model.trim().to_string();
                let response = self
                    .request_once(&fallback, request.messages, request.tools, cancellation)
                    .await?;
                Ok(ModelCompletion {
                    response,
                    provider: ModelProvider::OpenCodeZen,
                    model_used: fallback,
                    primary_model: primary,
                    fallback_used: true,
                    fallback_reason: Some(reason),
                })
            }
        }
    }
}

impl JarvisModelProvider for OpenCodeZenProvider {
    fn status(&self, settings: &TextModelSettings) -> ProviderStatus {
        let breaker = self.breaker.lock().ok().and_then(|value| value.clone());
        let active = breaker
            .as_ref()
            .filter(|value| value.until > Instant::now());
        ProviderStatus {
            provider: ModelProvider::OpenCodeZen,
            primary_model: settings.primary_model.clone(),
            fallback_model: settings.fallback_model.clone(),
            configured: self.credential().is_some(),
            fallback_enabled: settings.fallback_enabled,
            privacy_consent: settings.privacy_consent
                && settings
                    .privacy_consent_at
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty()),
            privacy_consent_at: settings.privacy_consent_at.clone(),
            primary_model_available: active.is_none(),
            circuit_breaker_until: active.map(|value| {
                (chrono::Utc::now()
                    + chrono::Duration::from_std(
                        value.until.saturating_duration_since(Instant::now()),
                    )
                    .unwrap_or_default())
                .to_rfc3339()
            }),
            circuit_breaker_reason: active.map(|value| value.reason.code().to_string()),
        }
    }

    fn complete(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ModelCompletion, ModelError>> + Send>> {
        let provider = self.clone();
        Box::pin(async move { provider.complete_inner(request, cancellation).await })
    }
}

#[derive(Debug, Serialize, PartialEq)]
struct ChatRequest {
    model: String,
    messages: Vec<ModelMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ModelToolDefinition>>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ModelToolCall>>,
}

fn build_payload(
    model: &str,
    mut messages: Vec<ModelMessage>,
    tools: Vec<ModelToolDefinition>,
) -> Result<ChatRequest, ModelError> {
    loop {
        let body = ChatRequest {
            model: model.to_string(),
            messages: messages.clone(),
            tools: (!tools.is_empty()).then(|| tools.clone()),
            max_tokens: 1400,
            temperature: 0.2,
        };
        let encoded = serde_json::to_vec(&body).map_err(|_| ModelError::InvalidPayload)?;
        if encoded.len() <= MAX_MODEL_PAYLOAD_BYTES {
            return Ok(body);
        }
        let last_user = messages.iter().rposition(|message| message.role == "user");
        let removable = messages
            .iter()
            .enumerate()
            .find(|(index, message)| message.role != "system" && Some(*index) != last_user)
            .map(|(index, _)| index);
        let Some(index) = removable else {
            return Err(ModelError::PayloadTooLarge);
        };
        messages.remove(index);
    }
}

async fn read_bounded_response(
    response: reqwest::Response,
    cancellation: CancellationToken,
) -> Result<Vec<u8>, ModelError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err(ModelError::InvalidResponse);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::select! {
        _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
        chunk = stream.next() => chunk
    } {
        let chunk = chunk.map_err(classify_transport)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ModelError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn classify_transport(error: reqwest::Error) -> ModelError {
    if error.is_timeout() {
        ModelError::Timeout
    } else {
        ModelError::Transport
    }
}

fn classify_http(status: StatusCode, body: &[u8]) -> ModelError {
    match status {
        StatusCode::UNAUTHORIZED => ModelError::AuthFailed,
        StatusCode::FORBIDDEN => ModelError::Forbidden,
        StatusCode::TOO_MANY_REQUESTS => ModelError::RateLimited,
        StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => ModelError::Server,
        StatusCode::NOT_FOUND => ModelError::ModelUnavailable,
        StatusCode::BAD_REQUEST if body_mentions_model_error(body) => ModelError::ModelUnavailable,
        _ => ModelError::InvalidResponse,
    }
}

fn body_mentions_model_error(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    [
        "model not found",
        "model_not_found",
        "unknown model",
        "unsupported model",
        "model unavailable",
        "model_unavailable",
        "does not exist",
    ]
    .iter()
    .any(|term| text.contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn settings() -> TextModelSettings {
        TextModelSettings {
            provider: ModelProvider::OpenCodeZen,
            primary_model: "longcat-2.0-free".into(),
            fallback_model: "deepseek-v4-flash-free".into(),
            fallback_enabled: true,
            privacy_consent: true,
            privacy_consent_at: Some("now".into()),
        }
    }

    fn request() -> ModelRequest {
        ModelRequest {
            settings: settings(),
            messages: vec![
                ModelMessage::new("system", "policy"),
                ModelMessage::new("user", "hello"),
            ],
            tools: vec![],
        }
    }

    async fn server(
        responses: Vec<(u16, &'static str)>,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request_bytes = [0u8; 4096];
                let _ = stream.read(&mut request_bytes).await;
                let line = format!("HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
                stream.write_all(line.as_bytes()).await.unwrap();
            }
        });
        (addr, handle)
    }

    fn ok(model: &'static str) -> &'static str {
        if model == "tool" {
            r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"1","type":"function","function":{"name":"agent.send","arguments":"{}"}}]}}]}"#
        } else {
            r#"{"choices":[{"message":{"content":"ok"}}]}"#
        }
    }

    #[tokio::test]
    async fn primary_success_reports_model_and_no_fallback() {
        let (addr, handle) = server(vec![(200, ok("primary"))]).await;
        let provider = OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
        let result = provider
            .complete(request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.model_used, "longcat-2.0-free");
        assert!(!result.fallback_used);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn nullable_content_and_multiple_tool_calls_are_decoded() {
        let body = r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"1","type":"function","function":{"name":"agent.list","arguments":"{}"}},{"id":"2","type":"function","function":{"name":"terminal.list","arguments":"{}"}}]}}]}"#;
        let (addr, handle) = server(vec![(200, body)]).await;
        let provider = OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
        let result = provider
            .complete(request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.response.content, "");
        assert_eq!(result.response.tool_calls.len(), 2);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn primary_model_unavailable_falls_back_once_and_opens_breaker() {
        let (addr, handle) = server(vec![
            (404, r#"{"error":"model not found"}"#),
            (200, ok("fallback")),
        ])
        .await;
        let provider = OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
        let result = provider
            .complete(request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.model_used, "deepseek-v4-flash-free");
        assert_eq!(
            result.fallback_reason,
            Some(FallbackReason::PrimaryModelUnavailable)
        );
        assert!(provider
            .status(&settings())
            .circuit_breaker_reason
            .is_some());
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn auth_error_does_not_fallback() {
        let (addr, handle) = server(vec![(401, r#"{"error":"no"}"#)]).await;
        let provider = OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
        assert_eq!(
            provider.complete(request(), CancellationToken::new()).await,
            Err(ModelError::AuthFailed)
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn rate_limit_and_server_error_use_fallback_once() {
        for status in [429, 500] {
            let (addr, handle) = server(vec![
                (status, r#"{"error":"temporary"}"#),
                (200, ok("fallback")),
            ])
            .await;
            let provider =
                OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
            let result = provider
                .complete(request(), CancellationToken::new())
                .await
                .unwrap();
            assert!(result.fallback_used);
            assert!(matches!(
                result.fallback_reason,
                Some(FallbackReason::RateLimited | FallbackReason::Server)
            ));
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn forbidden_error_does_not_use_fallback() {
        let (addr, handle) = server(vec![(403, r#"{"error":"forbidden"}"#)]).await;
        let provider = OpenCodeZenProvider::for_test(format!("http://{addr}"), Some("test-key"));
        assert_eq!(
            provider.complete(request(), CancellationToken::new()).await,
            Err(ModelError::Forbidden)
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn missing_consent_stops_before_network() {
        let mut no_consent = request();
        no_consent.settings.privacy_consent = false;
        let provider = OpenCodeZenProvider::for_test("http://127.0.0.1:1".into(), Some("test-key"));
        assert_eq!(
            provider
                .complete(no_consent, CancellationToken::new())
                .await,
            Err(ModelError::ConsentRequired)
        );
    }

    #[tokio::test]
    async fn consent_without_timestamp_stops_before_network() {
        let mut incomplete_consent = request();
        incomplete_consent.settings.privacy_consent_at = None;
        let provider = OpenCodeZenProvider::for_test("http://127.0.0.1:1".into(), Some("test-key"));
        assert_eq!(
            provider
                .complete(incomplete_consent, CancellationToken::new())
                .await,
            Err(ModelError::ConsentRequired)
        );
    }

    #[tokio::test]
    async fn cancellation_does_not_activate_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = listener.local_addr().unwrap();
        let _listener = listener;
        let provider = OpenCodeZenProvider::for_test(
            format!("http://{addr}", addr = local_addr),
            Some("test-key"),
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            provider.complete(request(), cancellation).await,
            Err(ModelError::Cancelled)
        );
    }

    #[tokio::test]
    async fn timeout_uses_fallback_without_racing_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut workers = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                workers.push(tokio::spawn(async move {
                    let mut request_bytes = [0u8; 1024];
                    let _ = stream.read(&mut request_bytes).await;
                    let body = ok("fallback");
                    if index == 0 {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                }));
            }
            for worker in workers {
                let _ = worker.await;
            }
        });
        let provider = OpenCodeZenProvider::for_timeout_test(format!("http://{addr}"));
        let result = provider.complete(request(), CancellationToken::new()).await;
        assert!(matches!(
            result,
            Ok(ModelCompletion {
                fallback_used: true,
                fallback_reason: Some(FallbackReason::Timeout),
                ..
            })
        ));
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn missing_credential_is_not_configured_without_reading_a_secret() {
        let provider = OpenCodeZenProvider::for_test("http://127.0.0.1:1".into(), None);
        let result = provider.complete(request(), CancellationToken::new()).await;
        assert_eq!(result, Err(ModelError::NotConfigured));
    }

    #[test]
    fn provider_status_never_serializes_the_credential() {
        let provider = OpenCodeZenProvider::for_test(
            "http://127.0.0.1:1".into(),
            Some("test-secret-that-must-not-escape"),
        );
        let serialized = serde_json::to_string(&provider.status(&settings())).unwrap();
        assert!(!serialized.contains("test-secret-that-must-not-escape"));
        assert!(serialized.contains("open_code_zen"));
    }

    #[test]
    fn payload_prunes_old_messages_and_preserves_policy_and_current_user() {
        let mut messages = vec![ModelMessage::new("system", "policy")];
        for _ in 0..20 {
            messages.push(ModelMessage::new("user", "é".repeat(12_000)));
        }
        messages.push(ModelMessage::new("user", "current"));
        let body = build_payload("model", messages, vec![]).unwrap();
        assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_MODEL_PAYLOAD_BYTES);
        assert_eq!(body.messages.first().unwrap().content, "policy");
        assert_eq!(body.messages.last().unwrap().content, "current");
    }

    #[test]
    fn payload_fails_when_system_and_current_cannot_fit() {
        let result = build_payload(
            "model",
            vec![
                ModelMessage::new("system", "x".repeat(80_000)),
                ModelMessage::new("user", "é".repeat(20_000)),
            ],
            vec![],
        );
        assert_eq!(result, Err(ModelError::PayloadTooLarge));
    }
}
