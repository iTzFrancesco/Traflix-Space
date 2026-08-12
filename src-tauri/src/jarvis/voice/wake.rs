use super::types::{error_view, VoiceErrorCode, WakeWordState, WakeWordStatusView};

pub const DEFAULT_WAKE_WORD: &str = "Hey Traflix";
pub const DEFAULT_WAKE_WORD_SENSITIVITY: f32 = 0.65;

/// Runtime configuration passed to a local keyword-spotting adapter.
///
/// The MVP deliberately keeps this independent from any vendor SDK or model
/// format. A future sherpa-onnx adapter can consume the same boundary without
/// changing capture, IPC, or UI state transitions.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeWordConfig {
    pub keyword: String,
    pub sensitivity: f32,
}

impl WakeWordConfig {
    pub fn new(keyword: impl Into<String>, sensitivity: f32) -> Self {
        let keyword = keyword.into().trim().to_string();
        Self {
            keyword: if keyword.is_empty() {
                DEFAULT_WAKE_WORD.to_string()
            } else {
                keyword
            },
            sensitivity: sensitivity.clamp(0.0, 1.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WakeWordDetection {
    pub score: f32,
}

/// Local-only detector boundary.
///
/// Implementations must never upload or persist raw audio. `process` is called
/// from the capture worker, not from a realtime CPAL callback, so an adapter
/// may perform bounded frame processing here.
pub trait WakeWordEngine: Send {
    fn backend_name(&self) -> &'static str;
    fn process(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        channels: u16,
    ) -> Option<WakeWordDetection>;
    fn reset(&mut self);
}

/// Safe fallback while the actual local engine and its model are not bundled.
/// It intentionally never reports a match and is useful in unit tests and
/// capability diagnostics.
#[derive(Debug, Default)]
pub struct DisabledWakeWordEngine;

impl WakeWordEngine for DisabledWakeWordEngine {
    fn backend_name(&self) -> &'static str {
        "disabled"
    }

    fn process(
        &mut self,
        _samples: &[f32],
        _sample_rate: u32,
        _channels: u16,
    ) -> Option<WakeWordDetection> {
        None
    }

    fn reset(&mut self) {}
}

/// The feature is intentionally declared before the dependency/model is
/// approved. Enabling it currently changes diagnostics only; it does not
/// pretend that a sherpa-onnx asset is available.
pub fn configured_backend_name() -> &'static str {
    if cfg!(feature = "wake-word-sherpa") {
        "sherpa-onnx (asset non configurato)"
    } else {
        "disabled"
    }
}

pub fn create_engine(_config: &WakeWordConfig) -> Result<Box<dyn WakeWordEngine>, VoiceErrorCode> {
    Err(VoiceErrorCode::WakeWordUnavailable)
}

pub fn status(enabled: bool, config: &WakeWordConfig) -> WakeWordStatusView {
    if !enabled {
        return WakeWordStatusView {
            state: WakeWordState::Off,
            enabled: false,
            keyword: config.keyword.clone(),
            engine: configured_backend_name().to_string(),
            score: None,
            error: None,
        };
    }

    WakeWordStatusView {
        state: WakeWordState::Unavailable,
        enabled: true,
        keyword: config.keyword.clone(),
        engine: configured_backend_name().to_string(),
        score: None,
        error: Some(error_view(
            VoiceErrorCode::WakeWordUnavailable,
            "Il detector locale e il relativo modello non sono inclusi in questa build.",
        )),
    }
}

pub fn off_status(config: &WakeWordConfig) -> WakeWordStatusView {
    status(false, config)
}

pub fn standby_status(enabled: bool, config: &WakeWordConfig) -> WakeWordStatusView {
    WakeWordStatusView {
        state: WakeWordState::Standby,
        enabled,
        keyword: config.keyword.clone(),
        engine: configured_backend_name().to_string(),
        score: None,
        error: None,
    }
}

pub fn listening_status(
    enabled: bool,
    config: &WakeWordConfig,
    score: Option<f32>,
) -> WakeWordStatusView {
    WakeWordStatusView {
        state: WakeWordState::Listening,
        enabled,
        keyword: config.keyword.clone(),
        engine: configured_backend_name().to_string(),
        score,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_uses_safe_defaults_and_bounded_sensitivity() {
        let config = WakeWordConfig::new("  ", 2.0);
        assert_eq!(config.keyword, DEFAULT_WAKE_WORD);
        assert_eq!(config.sensitivity, 1.0);
    }

    #[test]
    fn disabled_engine_never_reports_a_detection() {
        let mut engine = DisabledWakeWordEngine;
        assert_eq!(engine.backend_name(), "disabled");
        assert!(engine.process(&[0.1; 160], 16_000, 1).is_none());
    }

    #[test]
    fn enabled_status_exposes_unavailable_engine_without_claiming_standby() {
        let config = WakeWordConfig::new(DEFAULT_WAKE_WORD, DEFAULT_WAKE_WORD_SENSITIVITY);
        let status = status(true, &config);
        assert_eq!(status.state, WakeWordState::Unavailable);
        assert_eq!(
            status.error.as_ref().map(|error| error.code.as_str()),
            Some("wake_word_unavailable")
        );
    }

    #[test]
    fn off_status_is_disabled_even_when_a_keyword_is_configured() {
        let config = WakeWordConfig::new(DEFAULT_WAKE_WORD, DEFAULT_WAKE_WORD_SENSITIVITY);
        let status = off_status(&config);
        assert_eq!(status.state, WakeWordState::Off);
        assert!(!status.enabled);
        assert!(status.error.is_none());
    }
}
