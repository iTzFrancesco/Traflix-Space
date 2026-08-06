use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
pub const MIN_RECORDING_MS: u64 = 250;
pub const MAX_RECORDING_MS: u64 = 45_000;
pub const MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_VOICE_REQUESTS: usize = 32;
pub const MAX_VOICE_LEVEL_EVENTS_PER_SECOND: u32 = 20;
pub const GROQ_STT_MODEL: &str = "whisper-large-v3-turbo";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceRequestStatus {
    Idle,
    Recording,
    Stopping,
    Transcribing,
    TranscriptReady,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRequestStatusView {
    pub request_id: String,
    pub workspace_id: String,
    pub selected_device_id: Option<String>,
    pub status: VoiceRequestStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub normalized_level: f32,
    pub transcript: Option<String>,
    pub error: Option<VoiceErrorView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevelEvent {
    pub request_id: String,
    pub elapsed_ms: u64,
    pub normalized_level: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceErrorView {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct VoiceRequest {
    pub view: VoiceRequestStatusView,
    pub cancellation: CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TtsStatus {
    Idle,
    Synthesizing,
    Playing,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatusView {
    pub request_id: Option<String>,
    pub status: TtsStatus,
    pub error: Option<VoiceErrorView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakRequest {
    pub request_id: String,
    pub text: String,
    pub voice: Option<String>,
    pub rate: Option<String>,
    pub volume: Option<String>,
    pub pitch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub selected_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStopRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCancelRequest {
    pub request_id: String,
}

#[derive(Debug, Clone)]
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceErrorCode {
    ConsentRequired,
    ProviderNotConfigured,
    AuthFailed,
    Forbidden,
    RateLimited,
    ModelUnavailable,
    Timeout,
    Transport,
    InvalidResponse,
    AudioTooShort,
    AudioTooLarge,
    Cancelled,
    DeviceUnavailable,
    AlreadyActive,
    NotFound,
    InvalidRequest,
    HelperFailed,
    PlaybackFailed,
}

impl VoiceErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConsentRequired => "voice_consent_required",
            Self::ProviderNotConfigured => "voice_provider_not_configured",
            Self::AuthFailed => "stt_auth_failed",
            Self::Forbidden => "stt_forbidden",
            Self::RateLimited => "stt_rate_limited",
            Self::ModelUnavailable => "stt_model_unavailable",
            Self::Timeout => "stt_timeout",
            Self::Transport => "stt_transport_error",
            Self::InvalidResponse => "stt_invalid_response",
            Self::AudioTooShort => "audio_too_short",
            Self::AudioTooLarge => "audio_too_large",
            Self::Cancelled => "audio_cancelled",
            Self::DeviceUnavailable => "audio_device_unavailable",
            Self::AlreadyActive => "voice_request_active",
            Self::NotFound => "voice_request_not_found",
            Self::InvalidRequest => "voice_invalid_request",
            Self::HelperFailed => "tts_helper_failed",
            Self::PlaybackFailed => "tts_playback_failed",
        }
    }
}

pub fn error_view(code: VoiceErrorCode, message: impl Into<String>) -> VoiceErrorView {
    VoiceErrorView {
        code: code.as_str().to_string(),
        message: message.into(),
    }
}
