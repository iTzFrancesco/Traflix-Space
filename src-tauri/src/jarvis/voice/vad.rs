use serde::{Deserialize, Serialize};

/// Release ratio used to compute the end-of-speech threshold from the peak
/// RMS observed during speech: `base + (peak - base) * RELEASE_RATIO`. The
/// release threshold sits clearly above the absolute start threshold, so a
/// constant noise floor that is louder than the base threshold still counts
/// as trailing silence once a real phrase (much louder) has been heard.
const RELEASE_RATIO: f32 = 0.375;
const NOISE_GATE_RATIO: f32 = 1.35;
const NOISE_FLOOR_UPDATE_ALPHA: f32 = 0.75;
const NOISE_FLOOR_MAX_RATIO: f32 = 2.0;
const NOISE_CALIBRATION_MS: u64 = 300;
const STRONG_SPEECH_RATIO: f32 = 2.0;

/// A new RMS peak within this factor is considered a normal change in speaking
/// level and is accepted immediately. Larger jumps are accepted only after
/// they persist for multiple frames so a click/impact cannot poison the
/// release threshold while a genuinely louder phrase still can.
const MAX_PEAK_STEP_RATIO: f32 = 2.0;
const PEAK_JUMP_CONFIRM_FRAMES: u16 = 2;

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
    /// confirmed before they can replace this value.
    speech_peak_rms: f32,
    /// Candidate for a large sustained jump in speaking level.
    peak_jump_candidate_rms: f32,
    peak_jump_candidate_frames: u16,
    /// Smoothed ambient RMS collected before speech starts. This is a noise
    /// gate, not a replacement for the configured initial threshold.
    noise_floor_rms: f32,
    calibration_audio_ms: u64,
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
            peak_jump_candidate_rms: 0.0,
            peak_jump_candidate_frames: 0,
            noise_floor_rms: config.threshold * 0.5,
            calibration_audio_ms: 0,
        }
    }

    pub fn process(&mut self, samples: &[f32]) -> VadState {
        if samples.is_empty() {
            return self.state;
        }
        let rms = (samples
            .iter()
            .map(|sample| sample.clamp(-1.0, 1.0).powi(2))
            .sum::<f32>()
            / samples.len() as f32)
            .sqrt();
        let audio_ms = (samples.len() as u64)
            .div_ceil(self.config.channels as u64)
            .saturating_mul(1_000)
            .div_ceil(self.config.sample_rate as u64);
        self.update_noise_floor(rms, audio_ms);

        if !self.speech_started {
            // The configured threshold is the initial floor. After a short
            // calibration window, a dynamic noise gate prevents a constant
            // room tone from arming the microphone. Clearly strong speech can
            // bypass calibration so the first word is not held back.
            let start_threshold = self.start_threshold();
            let strong_speech = rms >= self.config.threshold * STRONG_SPEECH_RATIO;
            if rms >= start_threshold
                && (self.calibration_audio_ms >= NOISE_CALIBRATION_MS || strong_speech)
            {
                self.speech_frames = self.speech_frames.saturating_add(1);
                self.silence_frames = 0;
                self.silence_audio_frames = 0;
                self.state = if self.speech_frames >= self.config.start_frames {
                    self.speech_started = true;
                    self.speech_peak_rms = rms;
                    self.release_threshold =
                        release_threshold(self.config.threshold, rms, self.noise_floor_rms);
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

        self.update_representative_peak(rms);

        if rms >= self.release_threshold {
            self.silence_frames = 0;
            self.silence_audio_frames = 0;
            // A speaker may resume during the endpoint grace period. VAD is
            // reusable for that utterance; endpointing, not VAD, owns the
            // final stop decision.
            self.should_stop = false;
            self.state = VadState::Speech;
            return self.state;
        }

        // A candidate large peak jump is only meaningful while the high level
        // is sustained. Normal/silent frames cancel a one-frame transient.
        self.peak_jump_candidate_rms = 0.0;
        self.peak_jump_candidate_frames = 0;

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

    fn update_representative_peak(&mut self, rms: f32) {
        if rms <= self.speech_peak_rms {
            // Returning to the established speech range proves any pending
            // large jump was transient.
            self.peak_jump_candidate_rms = 0.0;
            self.peak_jump_candidate_frames = 0;
            return;
        }

        if rms <= self.speech_peak_rms * MAX_PEAK_STEP_RATIO {
            self.accept_peak(rms);
            return;
        }

        // Large jump: require consecutive high frames. Keep the strongest
        // value in the candidate window so a genuinely louder phrase can
        // raise the release threshold after confirmation.
        self.peak_jump_candidate_rms = self.peak_jump_candidate_rms.max(rms);
        self.peak_jump_candidate_frames = self.peak_jump_candidate_frames.saturating_add(1);
        if self.peak_jump_candidate_frames >= PEAK_JUMP_CONFIRM_FRAMES {
            let confirmed = self.peak_jump_candidate_rms;
            self.accept_peak(confirmed);
        }
    }

    fn accept_peak(&mut self, rms: f32) {
        self.speech_peak_rms = rms;
        self.release_threshold =
            release_threshold(self.config.threshold, rms, self.noise_floor_rms);
        self.peak_jump_candidate_rms = 0.0;
        self.peak_jump_candidate_frames = 0;
    }

    fn update_noise_floor(&mut self, rms: f32, audio_ms: u64) {
        self.calibration_audio_ms = self
            .calibration_audio_ms
            .saturating_add(audio_ms)
            .min(NOISE_CALIBRATION_MS);
        if self.speech_started()
            || self.calibration_audio_ms >= NOISE_CALIBRATION_MS
            || rms > self.config.threshold * NOISE_FLOOR_MAX_RATIO
        {
            return;
        }
        self.noise_floor_rms += (rms - self.noise_floor_rms) * NOISE_FLOOR_UPDATE_ALPHA;
    }

    fn start_threshold(&self) -> f32 {
        self.config
            .threshold
            .max(self.noise_floor_rms * NOISE_GATE_RATIO)
            .min(1.0)
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
fn release_threshold(base: f32, peak: f32, noise_floor: f32) -> f32 {
    (base + (peak - base) * RELEASE_RATIO)
        .max(noise_floor * NOISE_GATE_RATIO)
        .min(peak)
        .clamp(base, 1.0)
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
        // Room noise sits ABOVE the configured start threshold (0.018), so a
        // fixed-threshold detector would falsely arm. Calibration must gate it
        // out, while a later, clearly louder phrase must still start speech.
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.03; 100]);
        }
        assert!(!detector.speech_started());

        for _ in 0..5 {
            detector.process(&[0.2; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);
        for _ in 0..2 {
            detector.process(&[0.03; 100]);
            assert!(!detector.should_stop(), "trailing window not elapsed yet");
        }
        detector.process(&[0.03; 100]);
        assert!(
            detector.should_stop(),
            "noise floor must count as trailing silence"
        );
    }

    #[test]
    fn a_continuing_phrase_resets_the_trailing_silence_window() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.2; 100]);
        }
        assert!(detector.speech_started());
        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        assert_eq!(detector.state(), VadState::Silence);
        assert!(!detector.should_stop());
        detector.process(&[0.2; 100]);
        assert_eq!(detector.state(), VadState::Speech);
        assert!(!detector.should_stop());
        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        assert!(!detector.should_stop());
        detector.process(&[0.03; 100]);
        assert!(detector.should_stop());
    }

    #[test]
    fn calibrated_noise_gate_allows_voice_above_room_noise() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.03; 100]);
        }
        assert!(!detector.speech_started());

        for _ in 0..3 {
            detector.process(&[0.06; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);
    }

    #[test]
    fn strong_speech_at_capture_start_bypasses_calibration_without_losing_start() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.10; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);
    }

    #[test]
    fn quiet_speech_at_capture_start_is_not_absorbed_into_noise_calibration() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.04; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);
    }

    #[test]
    fn noise_gate_release_never_exceeds_a_quiet_voice_peak() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.03; 100]);
        }
        for _ in 0..3 {
            detector.process(&[0.04; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.process(&[0.04; 100]), VadState::Speech);
        assert!(!detector.should_stop());
    }

    #[test]
    fn speech_can_resume_after_an_endpoint_candidate() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.2; 100]);
        }
        for _ in 0..3 {
            detector.process(&[0.0; 100]);
        }
        assert!(detector.should_stop());
        assert_eq!(detector.process(&[0.2; 100]), VadState::Speech);
        assert!(!detector.should_stop());
    }

    #[test]
    fn release_threshold_tracks_quieter_peaks() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.04; 100]);
        }
        assert!(detector.speech_started());
        for _ in 0..4 {
            detector.process(&[0.04; 100]);
        }
        detector.process(&[0.02; 100]);
        detector.process(&[0.02; 100]);
        detector.process(&[0.02; 100]);
        assert!(detector.should_stop());
    }

    #[test]
    fn one_loud_transient_does_not_poison_release_threshold() {
        let mut detector = vad();
        for _ in 0..3 {
            detector.process(&[0.10; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);

        // One impact is not enough to redefine the representative voice peak.
        detector.process(&[0.80; 100]);
        assert_eq!(detector.state(), VadState::Speech);

        for _ in 0..10 {
            detector.process(&[0.10; 100]);
            assert_eq!(detector.state(), VadState::Speech);
            assert!(!detector.should_stop());
        }
    }

    #[test]
    fn sustained_large_level_jump_is_accepted_as_real_speech() {
        let mut detector = vad();
        // A noisy room can exceed the absolute start threshold without
        // arming the calibrated detector.
        for _ in 0..3 {
            detector.process(&[0.03; 100]);
        }
        assert!(!detector.speech_started());

        // A true phrase is much louder but sustained, so it must start speech
        // and update the representative peak rather than being rejected as a
        // transient.
        for _ in 0..3 {
            detector.process(&[0.20; 100]);
        }
        assert!(detector.speech_started());
        assert_eq!(detector.state(), VadState::Speech);

        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        detector.process(&[0.03; 100]);
        assert!(detector.should_stop());
    }
}
