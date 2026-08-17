use super::vad::VadState;
use crate::settings::store::VoiceActivationMode;
use serde::{Deserialize, Serialize};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
pub const MIN_RECORDING_MS: u64 = 250;
// Manual hold-to-talk follows Traflix Voice: allow a long capture and stop
// only when the user releases/toggles the shortcut.
pub const MAX_RECORDING_MS: u64 = 600_000;
// Ten minutes of mono 16 kHz PCM16 is about 19.2 MiB; leave headroom while
// staying below Groq's usual multipart upload ceiling.
pub const MAX_WAV_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_VOICE_REQUESTS: usize = 32;
pub const GROQ_STT_MODEL: &str = "whisper-large-v3-turbo";
pub const MAX_MP3_BYTES: u64 = 8 * 1024 * 1024;

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
    Armed,
    Recording,
    Stopping,
    Transcribing,
    TranscriptReady,
    Cancelled,
    Failed,
}

/// Endpointing phase exposed to the widget. It deliberately separates a
/// short pause from the final silence window so the UI never suggests that a
/// breath or micro-interruption has already ended the turn.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEndpointState {
    Standby,
    Speaking,
    Pause,
    Breath,
    MicroInterruption,
    Finalizing,
}

impl Default for VoiceEndpointState {
    fn default() -> Self {
        Self::Standby
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WakeWordState {
    Off,
    Standby,
    Listening,
    Fallback,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordStatusView {
    pub state: WakeWordState,
    pub enabled: bool,
    pub keyword: String,
    pub engine: String,
    pub score: Option<f32>,
    pub error: Option<VoiceErrorView>,
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
    pub activation_mode: VoiceActivationMode,
    pub vad_state: VadState,
    #[serde(default)]
    pub endpoint_state: VoiceEndpointState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevelEvent {
    pub request_id: String,
    pub elapsed_ms: u64,
    pub normalized_level: f32,
    pub vad_state: VadState,
    #[serde(default)]
    pub endpoint_state: VoiceEndpointState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceErrorView {
    pub code: String,
    pub message: String,
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
    pub workspace_id: Option<String>,
    pub sequence: u64,
    pub status: TtsStatus,
    pub error: Option<VoiceErrorView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakRequest {
    pub request_id: String,
    pub workspace_id: Option<String>,
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
    #[serde(default)]
    pub activation_mode: Option<VoiceActivationMode>,
    /// A VAD barge-in request may force endpointing for that capture even when
    /// the persisted policy has endpointing disabled; it never affects
    /// task/LLM cancellation. Hold-to-talk still remains fully manual.
    #[serde(default)]
    pub force_endpointing: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct VoiceCaptureOptions {
    pub activation_mode: VoiceActivationMode,
    pub max_duration_seconds: u32,
    pub max_armed_seconds: u32,
    pub vad_enabled: bool,
    pub vad_speech_threshold: f32,
    pub vad_start_frames: u16,
    pub vad_silence_frames: u16,
    pub vad_pre_roll_ms: u32,
    pub vad_post_speech_ms: u32,
}

impl VoiceCaptureOptions {
    pub fn bounded(self) -> Self {
        Self {
            max_duration_seconds: normalize_max_duration_seconds(self.max_duration_seconds),
            max_armed_seconds: self.max_armed_seconds.clamp(1, 120),
            vad_enabled: self.vad_enabled
                && self.activation_mode != crate::settings::store::VoiceActivationMode::HoldToTalk,
            vad_speech_threshold: self.vad_speech_threshold.clamp(0.001, 1.0),
            // Four consecutive blocks debounce clicks/fan pulses while the
            // preroll preserves the first syllable.
            vad_start_frames: self.vad_start_frames.clamp(4, 60),
            vad_silence_frames: self.vad_silence_frames.clamp(1, 120),
            vad_pre_roll_ms: self.vad_pre_roll_ms.clamp(0, 1_000),
            vad_post_speech_ms: self.vad_post_speech_ms.clamp(100, 5_000),
            activation_mode: self.activation_mode,
        }
    }
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
    VadTimeout,
    InvalidTransition,
    ShortcutUnavailable,
    ShortcutInvalid,
    TtsDisabled,
    TtsProviderInvalid,
    HelperFailed,
    TtsNetwork,
    TtsSynthesisFailed,
    TtsAudioFileInvalid,
    TtsAudioDecodeFailed,
    PlaybackDeviceUnavailable,
    PlaybackFailed,
    TtsTimeout,
    #[allow(dead_code)]
    WakeWordUnavailable,
    WakeWordDisabled,
    MicrophoneMuted,
}

pub fn normalize_max_duration_seconds(value: u32) -> u32 {
    value.clamp(1, (MAX_RECORDING_MS / 1000) as u32)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_max_duration_seconds, VoiceCaptureOptions, VoiceStartRequest, MAX_RECORDING_MS,
    };
    use crate::settings::store::VoiceActivationMode;

    #[test]
    fn corrupted_duration_is_bounded_for_capture_and_watchdog() {
        assert_eq!(normalize_max_duration_seconds(0), 1);
        assert_eq!(
            normalize_max_duration_seconds(999),
            MAX_RECORDING_MS as u32 / 1000
        );
        assert_eq!(normalize_max_duration_seconds(12), 12);
    }

    #[test]
    fn hands_free_arm_window_allows_two_minutes_without_churn() {
        let options = VoiceCaptureOptions {
            activation_mode: VoiceActivationMode::Vad,
            max_duration_seconds: 45,
            max_armed_seconds: 120,
            vad_enabled: true,
            vad_speech_threshold: 0.018,
            vad_start_frames: 3,
            vad_silence_frames: 16,
            vad_pre_roll_ms: 250,
            vad_post_speech_ms: 650,
        }
        .bounded();
        assert_eq!(options.max_armed_seconds, 120);
        assert_eq!(options.vad_start_frames, 4);
    }

    #[test]
    fn hold_to_talk_disables_stale_vad_configuration() {
        let options = VoiceCaptureOptions {
            activation_mode: VoiceActivationMode::HoldToTalk,
            max_duration_seconds: 600,
            max_armed_seconds: 120,
            vad_enabled: true,
            vad_speech_threshold: 0.018,
            vad_start_frames: 5,
            vad_silence_frames: 16,
            vad_pre_roll_ms: 500,
            vad_post_speech_ms: 650,
        }
        .bounded();
        assert!(!options.vad_enabled);
    }
    #[test]
    fn legacy_voice_start_requests_default_to_normal_endpointing_policy() {
        let request: VoiceStartRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request",
            "workspaceId": "workspace",
            "selectedDeviceId": null,
        }))
        .expect("legacy voice start request should remain readable");
        assert!(!request.force_endpointing);
    }
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
            Self::VadTimeout => "voice_vad_timeout",
            Self::InvalidTransition => "voice_invalid_transition",
            Self::ShortcutUnavailable => "voice_shortcut_unavailable",
            Self::ShortcutInvalid => "voice_shortcut_invalid",
            Self::TtsDisabled => "tts_output_disabled",
            Self::TtsProviderInvalid => "tts_provider_invalid",
            Self::HelperFailed => "tts_helper_failed",
            Self::TtsNetwork => "tts_network_failed",
            Self::TtsSynthesisFailed => "tts_synthesis_failed",
            Self::TtsAudioFileInvalid => "tts_audio_file_invalid",
            Self::TtsAudioDecodeFailed => "tts_audio_decode_failed",
            Self::PlaybackDeviceUnavailable => "tts_output_device_unavailable",
            Self::PlaybackFailed => "tts_playback_failed",
            Self::TtsTimeout => "tts_timeout",
            Self::WakeWordUnavailable => "wake_word_unavailable",
            Self::WakeWordDisabled => "wake_word_disabled",
            Self::MicrophoneMuted => "microphone_muted",
        }
    }
}

pub fn error_view(code: VoiceErrorCode, message: impl Into<String>) -> VoiceErrorView {
    VoiceErrorView {
        code: code.as_str().to_string(),
        message: message.into(),
    }
}
