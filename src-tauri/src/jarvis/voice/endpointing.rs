use std::time::{Duration, Instant};

use super::types::VoiceRequestStatusView;
use super::vad::VadState;

/// Endpointing is deliberately separate from VAD: VAD reports the current
/// audio state, while this controller decides when a silence is stable enough
/// to hand the capture to STT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointingDecision {
    Continue,
    PauseCandidate,
    Stop,
}

#[derive(Debug, Clone, Copy)]
pub struct EndpointingConfig {
    pub enabled: bool,
    pub grace_ms: u32,
    pub min_spoken_ms: u32,
}

impl EndpointingConfig {
    pub fn bounded(self) -> Self {
        Self {
            enabled: self.enabled,
            grace_ms: self.grace_ms.clamp(250, 5_000),
            min_spoken_ms: self.min_spoken_ms.clamp(100, 10_000),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EndpointingController {
    config: EndpointingConfig,
    recording_started_at: Option<Instant>,
    pause_started_at: Option<Instant>,
}

impl EndpointingController {
    pub fn new(config: EndpointingConfig) -> Self {
        Self {
            config: config.bounded(),
            recording_started_at: None,
            pause_started_at: None,
        }
    }

    pub fn observe(
        &mut self,
        now: Instant,
        status: &VoiceRequestStatusView,
        vad_should_stop: bool,
    ) -> EndpointingDecision {
        if !self.config.enabled || status.status != super::types::VoiceRequestStatus::Recording {
            self.recording_started_at = None;
            self.pause_started_at = None;
            return EndpointingDecision::Continue;
        }

        let recording_started_at = *self.recording_started_at.get_or_insert(now);
        if status.vad_state == VadState::Speech && !vad_should_stop {
            self.pause_started_at = None;
            return EndpointingDecision::Continue;
        }

        let pause_started_at = *self.pause_started_at.get_or_insert(now);
        if !vad_should_stop {
            return EndpointingDecision::PauseCandidate;
        }

        let spoken_for = now.saturating_duration_since(recording_started_at);
        let grace_elapsed = now.saturating_duration_since(pause_started_at)
            >= Duration::from_millis(self.config.grace_ms as u64);
        if grace_elapsed && spoken_for >= Duration::from_millis(self.config.min_spoken_ms as u64) {
            EndpointingDecision::Stop
        } else {
            EndpointingDecision::PauseCandidate
        }
    }

    #[cfg(test)]
    fn pause_started_at(&self) -> Option<Instant> {
        self.pause_started_at
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{EndpointingConfig, EndpointingController, EndpointingDecision};
    use crate::jarvis::voice::types::{VoiceRequestStatus, VoiceRequestStatusView};
    use crate::jarvis::voice::vad::VadState;
    use crate::settings::store::VoiceActivationMode;

    fn status(vad_state: VadState) -> VoiceRequestStatusView {
        VoiceRequestStatusView {
            request_id: "request".into(),
            workspace_id: "workspace".into(),
            selected_device_id: None,
            status: VoiceRequestStatus::Recording,
            created_at: "now".into(),
            started_at: Some("now".into()),
            duration_ms: Some(1_000),
            normalized_level: 0.2,
            transcript: None,
            error: None,
            activation_mode: VoiceActivationMode::Vad,
            vad_state,
        }
    }

    #[test]
    fn short_pause_never_stops_before_grace_period() {
        let start = Instant::now();
        let mut controller = EndpointingController::new(EndpointingConfig {
            enabled: true,
            grace_ms: 1_200,
            min_spoken_ms: 350,
        });
        let speech = status(VadState::Speech);
        assert_eq!(
            controller.observe(start, &speech, false),
            EndpointingDecision::Continue
        );
        let pause = status(VadState::Silence);
        assert_eq!(
            controller.observe(start + Duration::from_millis(100), &pause, false),
            EndpointingDecision::PauseCandidate
        );
        assert_eq!(
            controller.observe(start + Duration::from_millis(1_100), &pause, true),
            EndpointingDecision::PauseCandidate
        );
        assert!(controller.pause_started_at().is_some());
    }

    #[test]
    fn endpoint_stops_only_after_grace_and_minimum_spoken_duration() {
        let start = Instant::now();
        let mut controller = EndpointingController::new(EndpointingConfig {
            enabled: true,
            grace_ms: 1_200,
            min_spoken_ms: 350,
        });
        let speech = status(VadState::Speech);
        controller.observe(start, &speech, false);
        let pause = status(VadState::Silence);
        controller.observe(start + Duration::from_millis(500), &pause, false);
        assert_eq!(
            controller.observe(start + Duration::from_millis(1_699), &pause, true),
            EndpointingDecision::PauseCandidate
        );
        assert_eq!(
            controller.observe(start + Duration::from_millis(1_700), &pause, true),
            EndpointingDecision::Stop
        );
    }

    #[test]
    fn resumed_speech_clears_pending_endpoint() {
        let start = Instant::now();
        let mut controller = EndpointingController::new(EndpointingConfig {
            enabled: true,
            grace_ms: 1_200,
            min_spoken_ms: 350,
        });
        let speech = status(VadState::Speech);
        let pause = status(VadState::Silence);
        controller.observe(start, &speech, false);
        controller.observe(start + Duration::from_millis(400), &pause, true);
        assert_eq!(
            controller.observe(start + Duration::from_millis(900), &speech, false),
            EndpointingDecision::Continue
        );
        assert_eq!(
            controller.observe(start + Duration::from_millis(1_500), &pause, true),
            EndpointingDecision::PauseCandidate
        );
    }
}
