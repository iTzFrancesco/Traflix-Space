use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::capture::{AudioCaptureSession, AudioCaptureSource, PlatformAudioCapture};
use super::playback::{AudioPlayback, PlatformAudioPlayback};
use super::types::{
    error_view, TtsStatus, TtsStatusView, VoiceCaptureOptions, VoiceErrorCode, VoiceRequestStatus,
    VoiceRequestStatusView, MAX_VOICE_REQUESTS,
};
use super::vad::VadState;

struct ActiveVoiceRequest {
    view: VoiceRequestStatusView,
    cancellation: CancellationToken,
    capture: Option<Box<dyn AudioCaptureSession>>,
}

struct VoiceRegistryInner {
    requests: HashMap<String, ActiveVoiceRequest>,
    tts: TtsStatusView,
    tts_cancellation: Option<CancellationToken>,
    tts_active: bool,
    tts_cancel_requested: bool,
    tts_finished: Arc<Notify>,
}

pub struct VoiceSignal {
    pub status: VoiceRequestStatusView,
    pub should_stop: bool,
    pub status_changed: bool,
}

#[derive(Clone)]
pub struct VoiceState {
    inner: Arc<Mutex<VoiceRegistryInner>>,
    pub capture: Arc<dyn AudioCaptureSource>,
    pub playback: Arc<dyn AudioPlayback>,
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new(
            Arc::new(PlatformAudioCapture),
            Arc::new(PlatformAudioPlayback),
        )
    }
}

impl VoiceState {
    pub fn new(capture: Arc<dyn AudioCaptureSource>, playback: Arc<dyn AudioPlayback>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VoiceRegistryInner {
                requests: HashMap::new(),
                tts: TtsStatusView {
                    request_id: None,
                    status: TtsStatus::Idle,
                    error: None,
                },
                tts_cancellation: None,
                tts_active: false,
                tts_cancel_requested: false,
                tts_finished: Arc::new(Notify::new()),
            })),
            capture,
            playback,
        }
    }

    pub fn start(
        &self,
        request_id: String,
        workspace_id: String,
        selected_device_id: Option<String>,
        options: VoiceCaptureOptions,
    ) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let mut inner = self.inner.lock();
        if inner.requests.values().any(|request| {
            matches!(
                request.view.status,
                VoiceRequestStatus::Recording
                    | VoiceRequestStatus::Stopping
                    | VoiceRequestStatus::Transcribing
                    | VoiceRequestStatus::Armed
            )
        }) {
            return Err(VoiceErrorCode::AlreadyActive);
        }
        let capture = self
            .capture
            .start(selected_device_id.as_deref(), options.bounded())?;
        let now = chrono::Utc::now().to_rfc3339();
        let view = VoiceRequestStatusView {
            request_id: request_id.clone(),
            workspace_id,
            selected_device_id,
            status: if options.activation_mode == crate::settings::store::VoiceActivationMode::Vad {
                VoiceRequestStatus::Armed
            } else {
                VoiceRequestStatus::Recording
            },
            created_at: now.clone(),
            started_at: Some(now),
            duration_ms: Some(0),
            normalized_level: 0.0,
            transcript: None,
            error: None,
            activation_mode: options.activation_mode,
            vad_state: if options.activation_mode
                == crate::settings::store::VoiceActivationMode::Vad
            {
                VadState::Silence
            } else {
                VadState::Speech
            },
        };
        inner.requests.insert(
            request_id,
            ActiveVoiceRequest {
                view: view.clone(),
                cancellation: CancellationToken::new(),
                capture: Some(capture),
            },
        );
        prune(&mut inner.requests);
        Ok(view)
    }

    pub fn snapshot(
        &self,
        request_id: Option<&str>,
    ) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let mut inner = self.inner.lock();
        let id = request_id
            .map(ToOwned::to_owned)
            .or_else(|| {
                inner
                    .requests
                    .values()
                    .max_by_key(|request| request.view.created_at.clone())
                    .map(|request| request.view.request_id.clone())
            })
            .ok_or(VoiceErrorCode::NotFound)?;
        let request = inner
            .requests
            .get_mut(&id)
            .ok_or(VoiceErrorCode::NotFound)?;
        refresh_request(request);
        Ok(request.view.clone())
    }

    pub fn snapshot_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let mut inner = self.inner.lock();
        let id = inner
            .requests
            .values()
            .filter(|request| request.view.workspace_id == workspace_id)
            .max_by_key(|request| request.view.created_at.clone())
            .map(|request| request.view.request_id.clone())
            .ok_or(VoiceErrorCode::NotFound)?;
        let request = inner
            .requests
            .get_mut(&id)
            .ok_or(VoiceErrorCode::NotFound)?;
        refresh_request(request);
        Ok(request.view.clone())
    }

    pub fn signal(&self, request_id: &str) -> Result<VoiceSignal, VoiceErrorCode> {
        let (signal, capture_to_stop) = {
            let mut inner = self.inner.lock();
            let request = inner
                .requests
                .get_mut(request_id)
                .ok_or(VoiceErrorCode::NotFound)?;
            let previous_status = request.view.status.clone();
            let capture_failure = request
                .capture
                .as_ref()
                .and_then(|capture| capture.failure());
            if let Some(error) = capture_failure {
                request.cancellation.cancel();
                request.view.status = VoiceRequestStatus::Failed;
                request.view.transcript = None;
                request.view.error = Some(error_view(error, friendly_message(error)));
                request.view.duration_ms =
                    request.capture.as_ref().map(|capture| capture.elapsed_ms());
                let capture = request.capture.take();
                let signal = VoiceSignal {
                    status: request.view.clone(),
                    should_stop: false,
                    status_changed: previous_status != VoiceRequestStatus::Failed,
                };
                prune(&mut inner.requests);
                (signal, capture)
            } else {
                let changed = refresh_request(request);
                let should_stop = request
                    .capture
                    .as_ref()
                    .map(|capture| capture.should_auto_stop())
                    .unwrap_or(false);
                (
                    VoiceSignal {
                        status: request.view.clone(),
                        should_stop,
                        status_changed: changed,
                    },
                    None,
                )
            }
        };
        if let Some(capture) = capture_to_stop {
            let _ = capture.stop();
        }
        Ok(signal)
    }

    pub fn begin_stop(
        &self,
        request_id: &str,
    ) -> Result<
        (
            Box<dyn AudioCaptureSession>,
            CancellationToken,
            VoiceRequestStatusView,
        ),
        VoiceErrorCode,
    > {
        let mut inner = self.inner.lock();
        let request = inner
            .requests
            .get_mut(request_id)
            .ok_or(VoiceErrorCode::NotFound)?;
        refresh_request(request);
        if !matches!(request.view.status, VoiceRequestStatus::Recording) {
            return Err(VoiceErrorCode::InvalidRequest);
        }
        request.view.status = VoiceRequestStatus::Stopping;
        request.view.duration_ms = request.capture.as_ref().map(|capture| capture.elapsed_ms());
        let capture = request
            .capture
            .take()
            .ok_or(VoiceErrorCode::InvalidRequest)?;
        request.view.status = VoiceRequestStatus::Transcribing;
        Ok((capture, request.cancellation.clone(), request.view.clone()))
    }

    pub fn stop_armed(&self, request_id: &str) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let capture = {
            let mut inner = self.inner.lock();
            let request = inner
                .requests
                .get_mut(request_id)
                .ok_or(VoiceErrorCode::NotFound)?;
            refresh_request(request);
            if !matches!(request.view.status, VoiceRequestStatus::Armed) {
                return Err(VoiceErrorCode::InvalidRequest);
            }
            request.view.status = VoiceRequestStatus::Stopping;
            request.cancellation.cancel();
            request.capture.take()
        };
        if let Some(capture) = capture {
            let _ = capture.stop();
        }
        self.finish(request_id, VoiceRequestStatus::Idle, None, None)
    }

    pub fn timeout_armed(
        &self,
        request_id: &str,
    ) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let capture = {
            let mut inner = self.inner.lock();
            let request = inner
                .requests
                .get_mut(request_id)
                .ok_or(VoiceErrorCode::NotFound)?;
            refresh_request(request);
            if !matches!(request.view.status, VoiceRequestStatus::Armed) {
                return Err(VoiceErrorCode::InvalidRequest);
            }
            request.view.status = VoiceRequestStatus::Stopping;
            request.cancellation.cancel();
            request.capture.take()
        };
        if let Some(capture) = capture {
            let _ = capture.stop();
        }
        self.finish(
            request_id,
            VoiceRequestStatus::Idle,
            None,
            Some(VoiceErrorCode::VadTimeout),
        )
    }

    pub fn finish(
        &self,
        request_id: &str,
        status: VoiceRequestStatus,
        transcript: Option<String>,
        error: Option<VoiceErrorCode>,
    ) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let mut inner = self.inner.lock();
        let request = inner
            .requests
            .get_mut(request_id)
            .ok_or(VoiceErrorCode::NotFound)?;
        if matches!(
            request.view.status,
            VoiceRequestStatus::Idle
                | VoiceRequestStatus::TranscriptReady
                | VoiceRequestStatus::Cancelled
                | VoiceRequestStatus::Failed
        ) {
            if request.view.status == status {
                return Ok(request.view.clone());
            }
            return Err(VoiceErrorCode::InvalidTransition);
        }
        request.view.status = status;
        request.view.transcript = transcript;
        request.view.error = error.map(|code| error_view(code, friendly_message(code)));
        let result = request.view.clone();
        prune(&mut inner.requests);
        Ok(result)
    }

    pub fn cancel(&self, request_id: &str) -> Result<VoiceRequestStatusView, VoiceErrorCode> {
        let (capture, cancellation) = {
            let mut inner = self.inner.lock();
            let request = inner
                .requests
                .get_mut(request_id)
                .ok_or(VoiceErrorCode::NotFound)?;
            if matches!(
                request.view.status,
                VoiceRequestStatus::Idle
                    | VoiceRequestStatus::TranscriptReady
                    | VoiceRequestStatus::Cancelled
                    | VoiceRequestStatus::Failed
            ) {
                return Err(VoiceErrorCode::InvalidTransition);
            }
            request.cancellation.cancel();
            (request.capture.take(), request.cancellation.clone())
        };
        if let Some(capture) = capture {
            let _ = capture.stop();
        }
        let _ = cancellation;
        self.finish(
            request_id,
            VoiceRequestStatus::Cancelled,
            None,
            Some(VoiceErrorCode::Cancelled),
        )
    }

    pub fn discard_transcript(&self, request_id: &str) -> Result<(), VoiceErrorCode> {
        let mut inner = self.inner.lock();
        inner
            .requests
            .remove(request_id)
            .map(|_| ())
            .ok_or(VoiceErrorCode::NotFound)
    }

    pub fn begin_tts(&self, request_id: String) -> (CancellationToken, TtsStatusView) {
        let mut inner = self.inner.lock();
        if let Some(previous) = inner.tts_cancellation.take() {
            previous.cancel();
        }
        let token = CancellationToken::new();
        inner.tts = TtsStatusView {
            request_id: Some(request_id),
            status: TtsStatus::Synthesizing,
            error: None,
        };
        inner.tts_cancellation = Some(token.clone());
        inner.tts_active = true;
        inner.tts_cancel_requested = false;
        (token, inner.tts.clone())
    }

    pub fn set_tts_for(
        &self,
        request_id: &str,
        status: TtsStatus,
        error: Option<VoiceErrorCode>,
    ) -> Option<TtsStatusView> {
        let mut inner = self.inner.lock();
        if inner.tts.request_id.as_deref() != Some(request_id) {
            return None;
        }
        let final_status = if inner.tts_cancel_requested {
            TtsStatus::Stopped
        } else {
            status
        };
        inner.tts.status = final_status;
        inner.tts.error = error.map(|code| error_view(code, friendly_message(code)));
        if matches!(
            inner.tts.status,
            TtsStatus::Idle | TtsStatus::Stopped | TtsStatus::Failed
        ) {
            inner.tts_cancellation = None;
            inner.tts_active = false;
            inner.tts_finished.notify_waiters();
        }
        Some(inner.tts.clone())
    }

    pub fn tts_status(&self) -> TtsStatusView {
        self.inner.lock().tts.clone()
    }

    pub fn request_stop_tts(&self) -> (TtsStatusView, Option<String>) {
        let mut inner = self.inner.lock();
        let request_id = inner.tts.request_id.clone();
        if let Some(token) = inner.tts_cancellation.clone() {
            token.cancel();
            inner.tts_cancel_requested = true;
            inner.tts.status = TtsStatus::Stopped;
            inner.tts.error = None;
        }
        (inner.tts.clone(), request_id)
    }

    pub async fn wait_tts_request_finished(&self, request_id: Option<String>) {
        let Some(request_id) = request_id else { return };
        let notify = self.inner.lock().tts_finished.clone();
        loop {
            let finished = {
                let inner = self.inner.lock();
                inner.tts.request_id.as_deref() != Some(request_id.as_str()) || !inner.tts_active
            };
            if finished {
                return;
            }
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(5), notify.notified()).await;
            if self.inner.lock().tts.request_id.as_deref() != Some(request_id.as_str()) {
                return;
            }
        }
    }

    pub async fn shutdown(&self) -> Vec<VoiceRequestStatusView> {
        let (captures, tts_token, tts_request_id, cancelled_requests) = {
            let mut inner = self.inner.lock();
            let mut cancelled_requests = Vec::new();
            let captures = inner
                .requests
                .values_mut()
                .filter_map(|request| {
                    request.cancellation.cancel();
                    if matches!(
                        request.view.status,
                        VoiceRequestStatus::Recording
                            | VoiceRequestStatus::Armed
                            | VoiceRequestStatus::Stopping
                            | VoiceRequestStatus::Transcribing
                    ) {
                        request.view.status = VoiceRequestStatus::Cancelled;
                        request.view.transcript = None;
                        request.view.error = Some(error_view(
                            VoiceErrorCode::Cancelled,
                            friendly_message(VoiceErrorCode::Cancelled),
                        ));
                        cancelled_requests.push(request.view.clone());
                    }
                    request.capture.take()
                })
                .collect::<Vec<_>>();
            let tts_token = inner.tts_cancellation.clone();
            let tts_request_id = inner.tts.request_id.clone();
            if let Some(token) = &tts_token {
                token.cancel();
                inner.tts_cancel_requested = true;
                inner.tts.status = TtsStatus::Stopped;
            }
            (captures, tts_token, tts_request_id, cancelled_requests)
        };
        for capture in captures {
            let _ = capture.stop();
        }
        let _ = tts_token;
        self.wait_tts_request_finished(tts_request_id).await;
        cancelled_requests
    }
}

fn prune(requests: &mut HashMap<String, ActiveVoiceRequest>) {
    if requests.len() <= MAX_VOICE_REQUESTS {
        return;
    }
    let mut ids: Vec<(String, String)> = requests
        .iter()
        .filter(|(_, request)| {
            !matches!(
                request.view.status,
                VoiceRequestStatus::Recording
                    | VoiceRequestStatus::Armed
                    | VoiceRequestStatus::Stopping
                    | VoiceRequestStatus::Transcribing
            )
        })
        .map(|(id, request)| (request.view.created_at.clone(), id.clone()))
        .collect();
    ids.sort_by(|left, right| left.0.cmp(&right.0));
    for (_, id) in ids
        .into_iter()
        .take(requests.len().saturating_sub(MAX_VOICE_REQUESTS))
    {
        requests.remove(&id);
    }
}

pub fn friendly_message(code: VoiceErrorCode) -> &'static str {
    match code {
        VoiceErrorCode::ConsentRequired => "Attiva il consenso privacy vocale nelle impostazioni.",
        VoiceErrorCode::ProviderNotConfigured => "Configura GROQ_API_KEY nel backend.",
        VoiceErrorCode::AuthFailed => "La credenziale Groq non è valida.",
        VoiceErrorCode::Forbidden => "Groq ha rifiutato l'accesso.",
        VoiceErrorCode::RateLimited => "Limite Groq raggiunto; riprova più tardi.",
        VoiceErrorCode::ModelUnavailable => "Il modello Whisper richiesto non è disponibile.",
        VoiceErrorCode::Timeout => "La richiesta vocale è scaduta.",
        VoiceErrorCode::Transport => "Impossibile raggiungere Groq.",
        VoiceErrorCode::InvalidResponse => "Risposta vocale non valida.",
        VoiceErrorCode::AudioTooShort => "Parla per almeno 250 millisecondi.",
        VoiceErrorCode::AudioTooLarge => "La registrazione supera il limite consentito.",
        VoiceErrorCode::Cancelled => "Operazione vocale annullata.",
        VoiceErrorCode::DeviceUnavailable => "Microfono non disponibile.",
        VoiceErrorCode::AlreadyActive => "È già attiva una registrazione vocale.",
        VoiceErrorCode::NotFound => "Richiesta vocale non trovata.",
        VoiceErrorCode::InvalidRequest => "Richiesta vocale non valida.",
        VoiceErrorCode::VadTimeout => "Nessuna voce rilevata: microfono riarmato quando vuoi.",
        VoiceErrorCode::InvalidTransition => "Transizione vocale non valida.",
        VoiceErrorCode::ShortcutUnavailable => "La scorciatoia globale non è disponibile.",
        VoiceErrorCode::ShortcutInvalid => "La scorciatoia globale non è valida.",
        VoiceErrorCode::HelperFailed => "Edge TTS non è disponibile.",
        VoiceErrorCode::PlaybackFailed => "Riproduzione audio non disponibile.",
    }
}

fn refresh_request(request: &mut ActiveVoiceRequest) -> bool {
    let previous_status = request.view.status.clone();
    let Some(capture) = request.capture.as_ref() else {
        return false;
    };
    let speech_started = capture.speech_started();
    let elapsed_ms = capture.elapsed_ms();
    let level = capture.normalized_level().clamp(0.0, 1.0);
    let vad_state = capture.vad_state();
    if request.view.status == VoiceRequestStatus::Armed && speech_started {
        request.view.status = VoiceRequestStatus::Recording;
    }
    if matches!(
        request.view.status,
        VoiceRequestStatus::Armed | VoiceRequestStatus::Recording
    ) {
        request.view.duration_ms = Some(elapsed_ms);
        request.view.normalized_level = level;
        request.view.vad_state = vad_state;
    }
    request.view.status != previous_status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jarvis::voice::capture::{FailingCaptureSource, FakeCaptureSource};
    use crate::jarvis::voice::playback::FakePlayback;
    use crate::jarvis::voice::types::CapturedAudio;
    use crate::settings::store::VoiceActivationMode;

    fn test_options() -> VoiceCaptureOptions {
        VoiceCaptureOptions {
            activation_mode: VoiceActivationMode::ClickToggle,
            max_duration_seconds: 45,
            max_armed_seconds: 20,
            vad_enabled: false,
            vad_speech_threshold: 0.018,
            vad_start_frames: 3,
            vad_silence_frames: 16,
            vad_pre_roll_ms: 250,
            vad_post_speech_ms: 650,
        }
    }

    #[test]
    fn registry_keeps_workspace_binding_and_cancel_is_idempotent_at_state_level() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        let started = state
            .start("req".into(), "workspace-a".into(), None, test_options())
            .unwrap();
        assert_eq!(started.workspace_id, "workspace-a");
        let _ = state.cancel("req").unwrap();
        assert_eq!(
            state.snapshot(Some("req")).unwrap().status,
            VoiceRequestStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn cancelled_tts_a_cannot_overwrite_new_tts_b() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        let (_a_token, a_started) = state.begin_tts("tts-a".into());
        assert_eq!(a_started.status, TtsStatus::Synthesizing);
        let (_stopped, _a_id) = state.request_stop_tts();
        let (_b_token, b_started) = state.begin_tts("tts-b".into());
        assert_eq!(b_started.request_id.as_deref(), Some("tts-b"));
        assert!(state.set_tts_for("tts-a", TtsStatus::Idle, None).is_none());
        assert_eq!(state.tts_status().request_id.as_deref(), Some("tts-b"));
        assert_eq!(state.tts_status().status, TtsStatus::Synthesizing);
    }

    #[test]
    fn tts_transitions_are_request_scoped_and_end_idle() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        let (_token, synthesizing) = state.begin_tts("tts".into());
        assert_eq!(synthesizing.status, TtsStatus::Synthesizing);
        let playing = state.set_tts_for("tts", TtsStatus::Playing, None).unwrap();
        assert_eq!(playing.request_id.as_deref(), Some("tts"));
        let idle = state.set_tts_for("tts", TtsStatus::Idle, None).unwrap();
        assert_eq!(idle.status, TtsStatus::Idle);
    }

    #[test]
    fn vad_signal_reports_armed_to_recording_and_transcribing() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        let mut options = test_options();
        options.activation_mode = VoiceActivationMode::Vad;
        options.vad_enabled = true;
        let armed = state
            .start("vad-request".into(), "workspace-a".into(), None, options)
            .unwrap();
        assert_eq!(armed.status, VoiceRequestStatus::Armed);
        let signal = state.signal("vad-request").unwrap();
        assert_eq!(signal.status.status, VoiceRequestStatus::Recording);
        assert!(signal.status_changed);
        let (_capture, _token, transcribing) = state.begin_stop("vad-request").unwrap();
        assert_eq!(transcribing.status, VoiceRequestStatus::Transcribing);
    }

    #[test]
    fn capture_failure_is_reported_before_any_transcription() {
        let state = VoiceState::new(
            Arc::new(FailingCaptureSource {
                error: VoiceErrorCode::DeviceUnavailable,
            }),
            Arc::new(FakePlayback),
        );
        state
            .start(
                "failed-request".into(),
                "workspace-a".into(),
                None,
                test_options(),
            )
            .unwrap();
        let signal = state.signal("failed-request").unwrap();
        assert_eq!(signal.status.status, VoiceRequestStatus::Failed);
        assert!(signal.status_changed);
        assert_eq!(
            signal
                .status
                .error
                .as_ref()
                .map(|error| error.code.as_str()),
            Some("audio_device_unavailable")
        );
    }

    #[tokio::test]
    async fn shutdown_cancels_active_capture_before_jarvis_is_disabled() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        state
            .start(
                "shutdown-request".into(),
                "workspace-a".into(),
                None,
                test_options(),
            )
            .unwrap();
        let cancelled = state.shutdown().await;
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].status, VoiceRequestStatus::Cancelled);
        assert_eq!(state.tts_status().status, TtsStatus::Idle);
        assert_eq!(
            state.snapshot(Some("shutdown-request")).unwrap().status,
            VoiceRequestStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn vad_request_is_armed_and_shutdown_cancels_it_without_cloud_work() {
        let state = VoiceState::new(
            Arc::new(FakeCaptureSource {
                audio: CapturedAudio {
                    samples: vec![0.2; 8_000],
                    channels: 1,
                    sample_rate: 16_000,
                },
            }),
            Arc::new(FakePlayback),
        );
        let mut options = test_options();
        options.activation_mode = VoiceActivationMode::Vad;
        let started = state
            .start("vad-request".into(), "workspace-a".into(), None, options)
            .unwrap();
        assert_eq!(started.status, VoiceRequestStatus::Armed);
        let cancelled = state.shutdown().await;
        assert_eq!(cancelled[0].status, VoiceRequestStatus::Cancelled);
    }
}
