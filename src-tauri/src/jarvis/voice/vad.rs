use serde::{Deserialize, Serialize};

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
}

impl EnergyVad {
    pub fn new(config: EnergyVadConfig) -> Self {
        Self {
            config: config.bounded(),
            state: VadState::Silence,
            speech_frames: 0,
            silence_frames: 0,
            silence_audio_frames: 0,
            speech_started: false,
            should_stop: false,
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
        if rms >= self.config.threshold {
            self.speech_frames = self.speech_frames.saturating_add(1);
            self.silence_frames = 0;
            self.silence_audio_frames = 0;
            self.state = if self.speech_frames >= self.config.start_frames {
                self.speech_started = true;
                VadState::Speech
            } else {
                VadState::MaybeSpeech
            };
        } else if self.speech_started {
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
        } else {
            self.speech_frames = 0;
            self.state = VadState::Silence;
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
}
