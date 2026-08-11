use serde::{Deserialize, Serialize};

/// Release ratio used to compute the end-of-speech threshold from the peak
/// RMS observed during speech: `base + (peak - base) * RELEASE_RATIO`. The
/// release threshold sits clearly above the absolute start threshold, so a
/// constant noise floor that is louder than the base threshold still counts
/// as trailing silence once a real phrase (much louder) has been heard.
const RELEASE_RATIO: f32 = 0.375;

/// Once a representative speech peak has been established, a single frame
/// that jumps far above it is much more likely to be a click/impact than a
/// meaningful change in speaking level. Let genuine louder speech raise the
/// peak gradually, but do not let one transient permanently raise the release
/// threshold and make normal speech look like silence.
const MAX_PEAK_STEP_RATIO: f32 = 2.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VadState {
    Silence,
    MaybeSpeech,
    Speech,
}

#[derive(Debug, Clone, Copy)]
pub struct EnergyVadConfig {
    pub threshold: f32,
    pub start_frames: u16,
    pub silence_frames: u16,
    pub post_speech_ms: u32,
    pub sample_rate: u32,
    pub channels: u16,
}

impl EnergyVadConfig {
    pub fn bounded(self) -> Self {
        Self {
            threshold: self.threshold.clamp(0.001, 1.0),
            start_frames: self.start_frames.clamp(1, 60),
            silence_frames: self.silence_frames.clamp(1, 120),
            post_speech_ms: self.post_speech_ms.clamp(100, 5_000),
            sample_rate: self.sample_rate.max(1),
            channels: self.channels.max(1),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnergyVad {
    config: EnergyVadConfig,
    state: VadState,
    speech_frames: u16,
    silence_frames: u16,
    silence_audio_frames: u64,
    speech_started: bool,
    should_stop: bool,
    /// Highest representative RMS observed since speech started; drives the
    /// release threshold via hysteresis. Implausible one-frame spikes are
    /// ignored so they cannot poison end-of-speech detection.
    speech_peak_rms: f32,
    /// End-of-speech threshold, recomputed when a representative new speech
    /// peak is accepted. Only levels below this count as trailing silence once
    /// speech has started.
    release_threshold: f32,
}

impl EnergyVad {
    pub fn new(config: EnergyVadConfig) -> Self {
        let config = config.bounded();
        Self {
            release_threshold: config.threshold,
            config,
            state: VadState::Silence,
            speech_frames: 0,
            silence_frames: 0,
            silence_audio_frames: 0,
            speech_started: false,
            should_stop: false,
            speech_peak_rms: 0.0,
        }
    }

    pub fn process(&mut self, samples: &[f32]) -> VadState {
        if samples.is_empty() || self.should_stop {
            return self.state;
        }
        let rms = (samples
            .iter()
            .map(|sample| sample.clamp(-1.0, 1.0).powi(2))
            .sum::<f32>()
            / samples.len() as f32)
            .sqrt();

        if !self.speech_started {
            // The absolute threshold still gates speech START; hysteresis
            // only shapes the release side.
            if rms >= self.config.threshold {
                self.speech_frames = self.speech_frames.saturating_add(1);
                self.silence_frames = 0;
                self.silence_audio_frames = 0;
                self.state = if self.speech_frames >= self.config.start_frames {
                    self.speech_started = true;
                    self.speech_peak_rms = rms;
                    self.release_threshold = release_threshold(
                        self.config.threshold,
                        rms,
                    );
                    VadState::Speech
                } else {
                    VadState::MaybeSpeech
                };
            } else {
                self.speech_frames = 0;
                self.state = VadState::Silence;
            }
            return self.state;
        }

        // Speech in progress: update the representative peak only when the
        // increase is plausible relative to the already established voice.
        // A keyboard click / impact can be many times louder than speech; if
        // accepted, it would make the release threshold so high that normal
        // speech would be counted as trailing silence for the rest of the
        // utterance.
        if rms > self.speech_peak_rms
            && rms <= self.speech_peak_rms * MAX_PEAK_STEP_RATIO
        {
            self.speech_peak_rms = rms;
            self.release_threshold = release_threshold(self.config.threshold, rms);
        }
        if rms >= self.release_threshold {
            self.silence_frames = 0;
            self.silence_audio_frames = 0;
            self.state = VadState::Speech;
            return self.state;
        }

        // Below the release threshold: trailing silence. This includes
        // constant background noise that sits above the absolute start
        // threshold but far below the voice peak.
        self.silence_frames = self.silence_frames.saturating_add(1);
        let audio_frames = (samples.len() as u64)
            .div_ceil(self.config.channels as u64)
            .max(1);
        self.silence_audio_frames = self.silence_audio_frames.saturating_add(audio_frames);
        self.state = VadState::Silence;
        let silence_ms =
            self.silence_audio_frames.saturating_mul(1_000) / self.config.sample_rate as u64;
        if self.silence_frames >= self.config.silence_frames
            && silence_ms >= self.config.post_speech_ms as u64
        {
            self.should_stop = true;
        }
        self.state
    }

    pub fn state(&self) -> VadState {
        self.state
    }

    pub fn speech_started(&self) -> bool {
        self.speech_started
    }

    pub fn should_stop(&self) -> bool {
        self.should_stop
    }
}

/// Release threshold with relative hysteresis: the quieter the speech, the
/// closer the release sits to the base threshold; the louder the speech
/// peak, the higher the release climbs above any noise floor.
fn release_threshold(base: f32, peak: f32) -> f32 {
    (base + (peak - base) * RELEASE_RATIO).clamp(base, 1.0)
}

#[cfg(test)]
mod tests {
    use super::{EnergyVad, EnergyVadConfig, VadState};

    fn vad() -> EnergyVad {
        EnergyVad::new(EnergyVadConfig {
            threshold: 0.018,
            start_frames: 3,
            silence_frames: 3,
            post_speech_ms: 20,
            sample_rate: 1_000,
            channels: 1,
        })
    }

    #[test]
    fn silence_and_single_spike_do_not_start_speech() {
        let mut detector = vad();
        assert_eq!(detector.process(&[0.0; 100]), VadState::Silence);
        assert_eq!(detector.process(&[0.5]), VadState::MaybeSpeech);
        assert!(!detector.speech_started());
    }

    #[test]
    fn continuous_speech_requires_start_frames() {
        let mut detector = vad();
        assert_eq!(detector.process(&[0.2; 10]), VadState::MaybeSpeech);
        assert_eq!(detector.process(&[0.2; 10]), VadState::MaybeSpeech);
        assert_eq!(detector.process(&[0.2; 10]), VadState::Speech);
        assert!(detector.speech_started());
    }

    #[test]
    fn speech_transitions_to_silence_and_auto_stop() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.2; 10]);
        }
        assert_eq!(detector.process(&[0.0; 10]), VadState::Silence);
        for _ in 0..10 {
            detector.process(&[0.0; 10]);
        }
        assert!(detector.should_stop());
    }

    #[test]
    fn bounded_config_clamps_hostile_values() {
        let config = EnergyVadConfig {
            threshold: 99.0,
            start_frames: 0,
            silence_frames: u16::MAX,
            post_speech_ms: 0,
            sample_rate: 0,
            channels: 0,
        }
        .bounded();
        assert_eq!(config.threshold, 1.0);
        assert_eq!(config.start_frames, 1);
        assert_eq!(config.silence_frames, 120);
        assert_eq!(config.post_speech_ms, 100);
        assert_eq!(config.sample_rate, 1);
        assert_eq!(config.channels, 1);
    }

    #[test]
    fn mono_and_stereo_have_the_same_post_speech_timing() {
        fn reaches_stop(channels: u16) -> bool {
            let mut detector = EnergyVad::new(EnergyVadConfig {
                threshold: 0.018,
                start_frames: 1,
                silence_frames: 1,
                post_speech_ms: 650,
                sample_rate: 1_000,
                channels,
            });
            let speech = vec![0.2; 100 * channels as usize];
            detector.process(&speech);
            for _ in 0..6 {
                detector.process(&vec![0.0; 100 * channels as usize]);
            }
            assert!(!detector.should_stop());
            detector.process(&vec![0.0; 100 * channels as usize]);
            detector.should_stop()
        }

        assert_eq!(reaches_stop(1), reaches_stop(2));
        assert!(reaches_stop(1));
    }

    #[test]
    fn fixed_noise_above_base_threshold_does_not_keep_recording_after_a_phrase() {
        // Room noise sits ABOVE the absolute start threshold (0.018) the
        // whole time. The absolute threshold may start speech, but once a
        // much louder phrase raises the peak, the same noise floor must
        // count as trailing silence instead of keeping the recording alive.
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.03; 100]);
        }
        assert!(detector.speech_started());
        for _ in 0..5 {
            detector.process(&[0.2; 100]);
        }
        assert_eq!(detector.state(), VadState::Speech);
        // Back to the same fixed noise: release threshold is well above it.
        for _ in 0..2 {
            detector.process(&[0.03; 100]);
            assert!(!detector.should_stop(), "trailing window not elapsed yet");
        }
        detector.process(&[0.03; 100]);
        assert!(detector.should_stop(), "noise floor must count as trailing silence");
    }

    #[test]
    fn a_continuing_phrase_resets_the_trailing_silence_window() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.2; 100]);
        }
        assert!(detector.speech_started());
        // A short natural pause (still under the trailing window).
        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        assert_eq!(detector.state(), VadState::Silence);
        assert!(!detector.should_stop());
        // The phrase continues: trailing silence must be reset.
        detector.process(&[0.2; 100]);
        assert_eq!(detector.state(), VadState::Speech);
        assert!(!detector.should_stop());
        // A full trailing window is needed again before stopping.
        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        assert!(!detector.should_stop());
        detector.process(&[0.03; 100]);
        assert!(detector.should_stop());
    }

    #[test]
    fn release_threshold_tracks_quieter_peaks() {
        // Soft speech: release sits close to the base threshold, so a noise
        // floor barely above base still triggers auto-stop.
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.04; 100]);
        }
        assert!(detector.speech_started());
        for _ in 0..4 {
            detector.process(&[0.04; 100]);
        }
        // Noise between base (0.018) and release (0.02625) is trailing.
        detector.process(&[0.02; 100]);
        detector.process(&[0.02; 100]);
        detector.process(&[0.02; 100]);
        assert!(detector.should_stop());
    }

    #[test]
    fn one_loud_transient_does_not_poison_release_threshold() {
        let mut detector = vad();
        // Establish ordinary speech around 0.10 RMS.
        for _ in 0..3 {
            detector.process(&[0.10; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);

        // A single impact/click is far louder than the established voice.
        detector.process(&[0.80; 100]);
        assert_eq!(detector.state(), VadState::Speech);

        // Normal speech must continue to be recognized and must not inherit
        // a release threshold derived from the transient 0.80 spike.
        for _ in 0..10 {
            detector.process(&[0.10; 100]);
            assert_eq!(detector.state(), VadState::Speech);
            assert!(!detector.should_stop());
        }
    }
}