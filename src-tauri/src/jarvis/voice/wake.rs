use super::types::{VoiceErrorCode, WakeWordState, WakeWordStatusView};
use super::vad::{EnergyVad, EnergyVadConfig, VadState};

pub const DEFAULT_WAKE_WORD: &str = "Hey Traflix";
pub const DEFAULT_WAKE_WORD_SENSITIVITY: f32 = 0.65;
const FALLBACK_START_FRAMES: u16 = 3;
const FALLBACK_POST_SPEECH_MS: u32 = 100;

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

/// Test/capability-only detector that intentionally never reports a match.
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

/// Local fallback used until a model-backed keyword spotter is bundled.
///
/// This is deliberately voice-activity based, not a claim that the configured
/// phrase was recognized. It lets the user keep hands-free local activation
/// without sending standby audio to STT, while the status/UI make the reduced
/// capability explicit.
#[derive(Debug)]
pub struct LocalVadFallbackWakeEngine {
    sensitivity: f32,
    vad: Option<EnergyVad>,
}

impl LocalVadFallbackWakeEngine {
    pub fn new(config: &WakeWordConfig) -> Self {
        Self {
            sensitivity: config.sensitivity,
            vad: None,
        }
    }

    fn threshold(&self) -> f32 {
        // Keep the fallback above a quiet-room floor. Sensitivity lowers the
        // threshold only within a bounded range; three consecutive frames are
        // still required by EnergyVad before activation.
        (0.04 - self.sensitivity * 0.02).clamp(0.018, 0.04)
    }
}

impl WakeWordEngine for LocalVadFallbackWakeEngine {
    fn backend_name(&self) -> &'static str {
        "vad-fallback"
    }

    fn process(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        channels: u16,
    ) -> Option<WakeWordDetection> {
        if samples.is_empty() {
            return None;
        }
        let threshold = self.threshold();
        let vad = self.vad.get_or_insert_with(|| {
            EnergyVad::new(EnergyVadConfig {
                threshold,
                start_frames: FALLBACK_START_FRAMES,
                silence_frames: 1,
                post_speech_ms: FALLBACK_POST_SPEECH_MS,
                sample_rate,
                channels,
            })
        });
        (vad.process(samples) == VadState::Speech).then_some(WakeWordDetection {
            score: 0.5 + self.sensitivity * 0.5,
        })
    }

    fn reset(&mut self) {
        self.vad = None;
    }
}

/// The model-backed feature remains reserved until its dependency, model and
/// redistribution licence are present. Normal builds therefore use the local
/// VAD fallback instead of reporting an unusable wake-only session.
pub fn configured_backend_name() -> &'static str {
    if cfg!(feature = "wake-word-sherpa") {
        "vad-fallback (sherpa asset non configurato)"
    } else {
        "vad-fallback"
    }
}

pub fn create_engine(config: &WakeWordConfig) -> Result<Box<dyn WakeWordEngine>, VoiceErrorCode> {
    Ok(Box::new(LocalVadFallbackWakeEngine::new(config)))
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
        state: WakeWordState::Fallback,
        enabled: true,
        keyword: config.keyword.clone(),
        engine: configured_backend_name().to_string(),
        score: None,
        error: None,
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

    #[derive(Default)]
    struct RecordingWakeEngine {
        frames: Vec<(usize, u32, u16)>,
        reset_count: usize,
    }

    impl WakeWordEngine for RecordingWakeEngine {
        fn backend_name(&self) -> &'static str {
            "test-local"
        }

        fn process(
            &mut self,
            samples: &[f32],
            sample_rate: u32,
            channels: u16,
        ) -> Option<WakeWordDetection> {
            self.frames.push((samples.len(), sample_rate, channels));
            (samples.iter().copied().fold(0.0_f32, f32::max) >= 0.8)
                .then_some(WakeWordDetection { score: 0.91 })
        }

        fn reset(&mut self) {
            self.reset_count += 1;
        }
    }

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
    fn enabled_status_exposes_vad_fallback_without_claiming_keyword_detection() {
        let config = WakeWordConfig::new(DEFAULT_WAKE_WORD, DEFAULT_WAKE_WORD_SENSITIVITY);
        let status = status(true, &config);
        assert_eq!(status.state, WakeWordState::Fallback);
        assert_eq!(status.engine, "vad-fallback");
        assert!(status.error.is_none());
    }

    #[test]
    fn fallback_engine_requires_sustained_local_speech_before_activation() {
        let config = WakeWordConfig::new(DEFAULT_WAKE_WORD, DEFAULT_WAKE_WORD_SENSITIVITY);
        let mut engine = LocalVadFallbackWakeEngine::new(&config);

        assert!(engine.process(&[0.0; 160], 16_000, 1).is_none());
        assert!(engine.process(&[0.1; 160], 16_000, 1).is_none());
        assert!(engine.process(&[0.1; 160], 16_000, 1).is_none());
        assert!(engine.process(&[0.1; 160], 16_000, 1).is_some());
        engine.reset();
        assert!(engine.process(&[0.0; 160], 16_000, 1).is_none());
    }

    #[test]
    fn off_status_is_disabled_even_when_a_keyword_is_configured() {
        let config = WakeWordConfig::new(DEFAULT_WAKE_WORD, DEFAULT_WAKE_WORD_SENSITIVITY);
        let status = off_status(&config);
        assert_eq!(status.state, WakeWordState::Off);
        assert!(!status.enabled);
        assert!(status.error.is_none());
    }

    #[test]
    fn local_engine_receives_bounded_frames_and_resets_after_detection() {
        let mut engine = RecordingWakeEngine::default();

        assert!(engine.process(&[0.2; 160], 16_000, 1).is_none());
        let detection = engine.process(&[0.9; 160], 16_000, 1);

        assert_eq!(engine.backend_name(), "test-local");
        assert_eq!(engine.frames, vec![(160, 16_000, 1), (160, 16_000, 1)]);
        assert_eq!(detection, Some(WakeWordDetection { score: 0.91 }));
        engine.reset();
        assert_eq!(engine.reset_count, 1);
    }

    #[test]
    fn wake_status_transitions_preserve_local_keyword_and_engine_identity() {
        let config = WakeWordConfig::new("Hey Jarvis", 0.7);
        let standby = standby_status(true, &config);
        let listening = listening_status(true, &config, Some(0.88));

        assert_eq!(standby.state, WakeWordState::Standby);
        assert_eq!(listening.state, WakeWordState::Listening);
        assert_eq!(standby.keyword, "Hey Jarvis");
        assert_eq!(listening.keyword, "Hey Jarvis");
        assert_eq!(standby.engine, listening.engine);
        assert_eq!(listening.score, Some(0.88));
        assert!(standby.error.is_none());
        assert!(listening.error.is_none());
    }
}
