use crate::settings::store::SettingsManager;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tracing::{debug, error, info, warn};

use super::audio::{encode_wav_pcm16, wav_duration_ms};
use super::endpointing::{EndpointingConfig, EndpointingController, EndpointingDecision};
use super::registry::{friendly_message, VoiceState};
use super::stt::{GroqSpeechToTextProvider, SpeechToTextProvider};
use super::types::{
    error_view, normalize_max_duration_seconds, TtsSpeakRequest, TtsStatusView, VoiceCancelRequest,
    VoiceCaptureOptions, VoiceErrorCode, VoiceErrorView, VoiceInputDevice, VoiceLevelEvent,
    VoiceRequestStatus, VoiceRequestStatusView, VoiceStartRequest, VoiceStopRequest,
    WakeWordStatusView,
};
use super::wake::{self, WakeWordConfig};

#[path = "tts_commands.rs"]
mod tts_commands;

pub use tts_commands::TtsVoice;

#[tauri::command]
pub async fn jarvis_tts_speak(
    app: AppHandle,
    state: State<'_, VoiceState>,
    settings: State<'_, SettingsManager>,
    request: TtsSpeakRequest,
) -> Result<TtsStatusView, VoiceErrorView> {
    tts_commands::jarvis_tts_speak(app, state, settings, request).await
}

#[tauri::command]
pub async fn jarvis_tts_stop(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<TtsStatusView, VoiceErrorView> {
    tts_commands::jarvis_tts_stop(app, state).await
}

#[tauri::command]
pub fn jarvis_tts_status(state: State<'_, VoiceState>) -> TtsStatusView {
    tts_commands::jarvis_tts_status(state)
}

#[tauri::command]
pub async fn jarvis_tts_list_voices(
    app: AppHandle,
    settings: State<'_, SettingsManager>,
) -> Result<Vec<TtsVoice>, VoiceErrorView> {
    tts_commands::jarvis_tts_list_voices(app, settings).await
}

const VOICE_STATE_EVENT: &str = "jarvis://voice-state";
const VOICE_LEVEL_EVENT: &str = "jarvis://voice-level";
const TTS_STATE_EVENT: &str = "jarvis://tts-state";
const WAKE_STATE_EVENT: &str = "jarvis://wake-state";

fn active_voice_stops() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

struct VoiceStopClaim {
    request_id: String,
}

impl Drop for VoiceStopClaim {
    fn drop(&mut self) {
        active_voice_stops().lock().remove(&self.request_id);
    }
}

fn claim_voice_stop(request_id: &str) -> Option<VoiceStopClaim> {
    let mut active = active_voice_stops().lock();
    if !active.insert(request_id.to_string()) {
        return None;
    }
    Some(VoiceStopClaim {
        request_id: request_id.to_string(),
    })
}

#[tauri::command]
pub fn jarvis_voice_list_input_devices(
    state: State<'_, VoiceState>,
) -> Result<Vec<VoiceInputDevice>, VoiceErrorView> {
    state.capture.list_input_devices().map_err(to_error)
}

#[tauri::command]
pub async fn jarvis_wake_word_status(
    settings: State<'_, SettingsManager>,
) -> Result<WakeWordStatusView, VoiceErrorView> {
    let configured = settings.get().await;
    let config = WakeWordConfig::new(
        configured.jarvis.wake_word_phrase,
        configured.jarvis.wake_word_sensitivity,
    )
    .with_speech_threshold(configured.jarvis.voice_input.vad_speech_threshold);
    Ok(if configured.jarvis.muted {
        wake::off_status(&config)
    } else {
        wake::status(configured.jarvis.wake_word_enabled, &config)
    })
}

#[tauri::command]
pub async fn jarvis_voice_start(
    app: AppHandle,
    state: State<'_, VoiceState>,
    settings: State<'_, SettingsManager>,
    request: VoiceStartRequest,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    info!(
        request_id = %request.request_id,
        workspace_id = %request.workspace_id,
        selected_device = ?request.selected_device_id,
        "Voice start requested"
    );
    let configured = settings.get().await;
    ensure_microphone_unmuted(configured.jarvis.muted).inspect_err(|_| {
        warn!(request_id = %request.request_id, "Voice start rejected because Jarvis microphone is muted");
    })?;
    let input = configured.jarvis.voice_input.clone();
    let activation_mode = request.activation_mode.unwrap_or(input.activation_mode);
    crate::settings::secrets::refresh_dotenv_environment(&app);
    // Wake-word standby is a local microphone/VAD feature. Do not require
    // Groq just to open the microphone; the provider is resolved when a
    // captured utterance is actually handed to STT.
    let provider_configured = if activation_mode
        == crate::settings::store::VoiceActivationMode::WakeWord
    {
        false
    } else {
        GroqSpeechToTextProvider::from_environment()
            .map_err(|code| {
                warn!(request_id = %request.request_id, error_code = %code.as_str(), "Voice provider configuration lookup failed");
                to_error(code)
            })?
            .configured()
    };
    debug!(
        request_id = %request.request_id,
        provider_configured,
        activation_mode = ?activation_mode,
        vad_enabled = configured.jarvis.voice_input.vad_enabled,
        "Voice start configuration resolved"
    );
    ensure_input_allowed(&input, provider_configured, activation_mode).inspect_err(|error| {
        warn!(request_id = %request.request_id, error_code = %error.code, "Voice start rejected by input policy");
    })?;
    let max_duration_seconds =
        normalize_max_duration_seconds(configured.jarvis.voice_input.max_duration_seconds);
    // Click-toggle is the only capture path exposed by the current UI. Do not
    // let stale VAD settings from an older persisted profile re-enable
    // endpointing or automatic capture.
    let automatic_capture = !matches!(
        activation_mode,
        crate::settings::store::VoiceActivationMode::ClickToggle
            | crate::settings::store::VoiceActivationMode::HoldToTalk
    );
    let options = VoiceCaptureOptions {
        activation_mode,
        max_duration_seconds,
        max_armed_seconds: input.max_armed_seconds,
        vad_enabled: automatic_capture
            && (input.vad_enabled
                || activation_mode == crate::settings::store::VoiceActivationMode::Vad
                || activation_mode == crate::settings::store::VoiceActivationMode::WakeWord),
        vad_speech_threshold: input.vad_speech_threshold,
        vad_start_frames: input.vad_start_frames,
        vad_silence_frames: input.vad_silence_frames,
        vad_pre_roll_ms: input.vad_pre_roll_ms,
        vad_post_speech_ms: input.vad_post_speech_ms,
    }
    .bounded();
    let wake_config = WakeWordConfig::new(
        configured.jarvis.wake_word_phrase.clone(),
        configured.jarvis.wake_word_sensitivity,
    )
    .with_speech_threshold(input.vad_speech_threshold);
    let wake_engine = if activation_mode == crate::settings::store::VoiceActivationMode::WakeWord {
        if !configured.jarvis.wake_word_enabled {
            return Err(to_error(VoiceErrorCode::WakeWordDisabled));
        }
        Some(wake::create_engine(&wake_config).map_err(to_error)?)
    } else {
        None
    };
    let force_endpointing = request.force_endpointing;
    let request_id_for_log = request.request_id.clone();
    let status = state
        .start_with_wake_engine(
            request.request_id,
            request.workspace_id,
            request.selected_device_id,
            options,
            wake_engine,
        )
        .map_err(|code| {
            warn!(request_id = %request_id_for_log, error_code = %code.as_str(), "Voice registry rejected start");
            to_error(code)
        })?;
    info!(
        request_id = %status.request_id,
        workspace_id = %status.workspace_id,
        status = ?status.status,
        "Voice capture started"
    );
    emit_voice_state(&app, &status);
    if status.activation_mode == crate::settings::store::VoiceActivationMode::WakeWord {
        emit_wake_state(&app, &wake::standby_status(true, &wake_config));
    }
    let mut watchdog_config = configured.jarvis.voice_input.clone();
    watchdog_config.max_duration_seconds = max_duration_seconds;
    watchdog_config.max_armed_seconds = options.max_armed_seconds;
    watchdog_config.endpointing_enabled =
        automatic_capture && (watchdog_config.endpointing_enabled || force_endpointing);
    // One watchdog owns capture telemetry, endpointing and automatic stops.
    // Separate readers of VoiceState used to race on Armed→Recording and emit
    // duplicate intermediate events while the stop pipeline was starting.
    let watchdog_app = app.clone();
    let watchdog_state = (*state).clone();
    let watchdog_request_id = status.request_id.clone();
    let watchdog_wake_config = wake_config;
    tokio::spawn(async move {
        let mut endpointing = EndpointingController::new(EndpointingConfig {
            enabled: watchdog_config.endpointing_enabled,
            grace_ms: watchdog_config.endpoint_grace_ms,
            min_spoken_ms: watchdog_config.min_spoken_ms,
        });
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let Ok(signal) = watchdog_state.signal(&watchdog_request_id) else {
                break;
            };
            let status_changed = signal.status_changed;
            let should_stop = signal.should_stop;
            let current = signal.status;

            if status_changed
                && (matches!(
                    current.status,
                    VoiceRequestStatus::Recording | VoiceRequestStatus::Armed
                ) || current.status == VoiceRequestStatus::Failed)
            {
                info!(
                    request_id = %watchdog_request_id,
                    status = ?current.status,
                    vad_state = ?current.vad_state,
                    level = current.normalized_level,
                    "Voice capture state changed"
                );
                emit_voice_state(&watchdog_app, &current);
                if current.activation_mode == crate::settings::store::VoiceActivationMode::WakeWord
                    && current.status == VoiceRequestStatus::Recording
                {
                    emit_wake_state(
                        &watchdog_app,
                        &wake::listening_status(true, &watchdog_wake_config, None),
                    );
                }
            }
            if !matches!(
                current.status,
                VoiceRequestStatus::Recording | VoiceRequestStatus::Armed
            ) {
                break;
            }

            let _ = watchdog_app.emit(
                VOICE_LEVEL_EVENT,
                VoiceLevelEvent {
                    request_id: watchdog_request_id.clone(),
                    elapsed_ms: current.duration_ms.unwrap_or_default(),
                    normalized_level: current.normalized_level,
                    vad_state: current.vad_state,
                    endpoint_state: current.endpoint_state,
                },
            );

            if current.status == VoiceRequestStatus::Recording {
                match endpointing.observe(Instant::now(), &current, should_stop) {
                    EndpointingDecision::Stop => {
                        info!(request_id = %watchdog_request_id, "Voice endpoint confirmed after silence grace period");
                        if let Err(error) = finish_voice_stop(
                            &watchdog_app,
                            &watchdog_state,
                            watchdog_config.clone(),
                            watchdog_request_id.clone(),
                        )
                        .await
                        {
                            error!(request_id = %watchdog_request_id, error_code = %error.code, "Automatic voice endpoint stop failed");
                        }
                        break;
                    }
                    EndpointingDecision::PauseCandidate | EndpointingDecision::Continue => {}
                }
            }

            if current.status == VoiceRequestStatus::Armed {
                if current.duration_ms.unwrap_or_default()
                    >= watchdog_config.max_armed_seconds as u64 * 1000
                {
                    info!(request_id = %watchdog_request_id, "Voice armed timeout reached");
                    if let Ok(status) = watchdog_state.timeout_armed(&watchdog_request_id) {
                        emit_voice_state(&watchdog_app, &status);
                    } else {
                        warn!(request_id = %watchdog_request_id, "Voice armed timeout could not transition request");
                    }
                    break;
                }
            } else if automatic_capture
                && current.status == VoiceRequestStatus::Recording
                && current.duration_ms.unwrap_or_default() >= max_duration_seconds as u64 * 1000
            {
                info!(request_id = %watchdog_request_id, "Voice maximum recording duration reached");
                if let Err(error) = finish_voice_stop(
                    &watchdog_app,
                    &watchdog_state,
                    watchdog_config.clone(),
                    watchdog_request_id.clone(),
                )
                .await
                {
                    error!(request_id = %watchdog_request_id, error_code = %error.code, "Maximum-duration voice stop failed");
                }
                break;
            }
        }
    });
    Ok(status)
}

#[tauri::command]
pub async fn jarvis_voice_stop(
    app: AppHandle,
    state: State<'_, VoiceState>,
    settings: State<'_, SettingsManager>,
    request: VoiceStopRequest,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    let mut config = settings.get().await.jarvis.voice_input;
    config.max_duration_seconds = normalize_max_duration_seconds(config.max_duration_seconds);
    finish_voice_stop(&app, &state, config, request.request_id).await
}

async fn finish_voice_stop(
    app: &AppHandle,
    state: &VoiceState,
    config: crate::settings::store::VoiceInputSettings,
    request_id: String,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    info!(request_id = %request_id, "Voice stop pipeline entered");
    let Some(_stop_claim) = claim_voice_stop(&request_id) else {
        warn!(request_id = %request_id, "Duplicate voice stop ignored by single-flight guard");
        return state.snapshot(Some(&request_id)).map_err(|code| {
            error!(request_id = %request_id, error_code = %code.as_str(), "Could not read request after duplicate voice stop");
            to_error(code)
        });
    };
    let signal = state.signal(&request_id).map_err(|code| {
        error!(request_id = %request_id, error_code = %code.as_str(), "Voice stop could not read request state");
        to_error(code)
    })?;
    debug!(
        request_id = %request_id,
        status = ?signal.status.status,
        status_changed = signal.status_changed,
        should_stop = signal.should_stop,
        "Voice stop pipeline observed request"
    );
    if signal.status_changed {
        emit_voice_state(app, &signal.status);
    }
    if signal.status.status == VoiceRequestStatus::Failed {
        warn!(request_id = %request_id, error_code = ?signal.status.error.as_ref().map(|error| &error.code), "Voice request already failed before stop");
        return Ok(signal.status);
    }
    if signal.status.status == VoiceRequestStatus::Armed {
        let status = state.stop_armed(&request_id).map_err(|code| {
            error!(request_id = %request_id, error_code = %code.as_str(), "Armed voice request could not stop");
            to_error(code)
        })?;
        info!(request_id = %request_id, status = ?status.status, "Armed voice request stopped without transcription");
        emit_voice_state(app, &status);
        return Ok(status);
    }
    let (capture, cancellation, transcribing) = match state.begin_stop(&request_id) {
        Ok(result) => result,
        Err(VoiceErrorCode::InvalidRequest) => {
            let current = state.snapshot(Some(&request_id)).map_err(|code| {
                error!(request_id = %request_id, error_code = %code.as_str(), "Voice stop could not recover current request after duplicate stop");
                to_error(code)
            })?;
            if matches!(
                current.status,
                VoiceRequestStatus::Transcribing
                    | VoiceRequestStatus::TranscriptReady
                    | VoiceRequestStatus::Cancelled
                    | VoiceRequestStatus::Failed
            ) {
                warn!(request_id = %request_id, status = ?current.status, "Duplicate voice stop ignored; another stop pipeline owns the request");
                return Ok(current);
            }
            error!(request_id = %request_id, status = ?current.status, "Voice stop rejected from unexpected state");
            return Err(to_error(VoiceErrorCode::InvalidRequest));
        }
        Err(code) => {
            error!(request_id = %request_id, error_code = %code.as_str(), "Voice stop could not begin");
            return Err(to_error(code));
        }
    };
    info!(request_id = %request_id, status = ?transcribing.status, "Voice capture stopped; transcription begins");
    emit_voice_state(app, &transcribing);
    let audio = match capture.stop() {
        Ok(audio) => {
            info!(request_id = %request_id, samples = audio.samples.len(), sample_rate = audio.sample_rate, channels = audio.channels, "Voice audio captured");
            audio
        }
        Err(code) => {
            error!(request_id = %request_id, error_code = %code.as_str(), "Voice capture stop failed");
            let status = state
                .finish(&request_id, VoiceRequestStatus::Failed, None, Some(code))
                .map_err(to_error)?;
            emit_voice_state(app, &status);
            return Ok(status);
        }
    };
    if cancellation.is_cancelled() {
        info!(request_id = %request_id, "Voice transcription cancelled before encoding or STT");
        let status = state
            .finish(
                &request_id,
                VoiceRequestStatus::Cancelled,
                None,
                Some(VoiceErrorCode::Cancelled),
            )
            .map_err(to_error)?;
        emit_voice_state(app, &status);
        return Ok(status);
    }
    let wav = match encode_wav_pcm16(&audio) {
        Ok(wav) => {
            debug!(request_id = %request_id, wav_bytes = wav.len(), "Voice audio encoded as WAV");
            wav
        }
        Err(code) => {
            error!(request_id = %request_id, error_code = %code.as_str(), "Voice audio encoding failed");
            let status = state
                .finish(&request_id, VoiceRequestStatus::Failed, None, Some(code))
                .map_err(to_error)?;
            emit_voice_state(app, &status);
            return Ok(status);
        }
    };
    let duration_ms = wav_duration_ms(&wav);
    debug!(request_id = %request_id, duration_ms = ?duration_ms, "Voice WAV duration measured");
    crate::settings::secrets::refresh_dotenv_environment(app);
    let provider = match GroqSpeechToTextProvider::from_environment() {
        Ok(provider) => provider,
        Err(code) => {
            error!(request_id = %request_id, error_code = %code.as_str(), "Voice STT provider lookup failed during stop");
            let status = state
                .finish(&request_id, VoiceRequestStatus::Failed, None, Some(code))
                .map_err(to_error)?;
            emit_voice_state(app, &status);
            return Ok(status);
        }
    };
    if !provider.configured() {
        warn!(request_id = %request_id, "Voice STT provider is not configured");
        let status = state
            .finish(
                &request_id,
                VoiceRequestStatus::Failed,
                None,
                Some(VoiceErrorCode::ProviderNotConfigured),
            )
            .map_err(to_error)?;
        emit_voice_state(app, &status);
        return Ok(status);
    }
    info!(request_id = %request_id, wav_bytes = wav.len(), language = %config.language, "Voice STT request started");
    let result = provider
        .transcribe(wav, config.language, cancellation)
        .await;
    let (next_status, transcript, error) = match result {
        Ok(text) => {
            let preview: String = text.chars().take(200).collect();
            info!(
                request_id = %request_id,
                transcript_chars = text.chars().count(),
                transcript = %preview,
                "Voice STT request completed"
            );
            (VoiceRequestStatus::TranscriptReady, Some(text), None)
        }
        Err(code) => {
            warn!(request_id = %request_id, error_code = %code.as_str(), "Voice STT request failed");
            (
                if code == VoiceErrorCode::Cancelled {
                    VoiceRequestStatus::Cancelled
                } else {
                    VoiceRequestStatus::Failed
                },
                None,
                Some(code),
            )
        }
    };
    let mut status = state
        .finish(&request_id, next_status, transcript, error)
        .map_err(|code| {
            error!(request_id = %request_id, error_code = %code.as_str(), "Voice request could not enter terminal STT state");
            to_error(code)
        })?;
    if let Some(duration) = duration_ms {
        status.duration_ms = Some(duration);
    }
    info!(
        request_id = %request_id,
        status = ?status.status,
        error_code = ?status.error.as_ref().map(|error| &error.code),
        transcript_chars = status.transcript.as_deref().map(str::chars).map(Iterator::count),
        "Voice stop pipeline completed"
    );
    emit_voice_state(app, &status);
    Ok(status)
}

#[tauri::command]
pub fn jarvis_voice_cancel(
    app: AppHandle,
    state: State<'_, VoiceState>,
    request: VoiceCancelRequest,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    let status = state.cancel(&request.request_id).map_err(to_error)?;
    emit_voice_state(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn jarvis_voice_status(
    state: State<'_, VoiceState>,
    request_id: Option<String>,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    state.snapshot(request_id.as_deref()).map_err(to_error)
}

#[tauri::command]
pub fn jarvis_voice_workspace_status(
    state: State<'_, VoiceState>,
    workspace_id: String,
) -> Result<Option<VoiceRequestStatusView>, VoiceErrorView> {
    match state.snapshot_workspace(&workspace_id) {
        Ok(status) => Ok(Some(status)),
        Err(VoiceErrorCode::NotFound) => Ok(None),
        Err(code) => Err(to_error(code)),
    }
}

#[tauri::command]
pub fn jarvis_voice_discard_transcript(
    state: State<'_, VoiceState>,
    request_id: String,
) -> Result<(), VoiceErrorView> {
    state.discard_transcript(&request_id).map_err(to_error)
}

#[tauri::command]
pub async fn jarvis_voice_shutdown(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<(), VoiceErrorView> {
    for status in state.shutdown().await {
        emit_voice_state(&app, &status);
    }
    emit_tts_state(&app, &state.tts_status());
    Ok(())
}

fn ensure_input_allowed(
    settings: &crate::settings::store::VoiceInputSettings,
    provider_configured: bool,
    activation_mode: crate::settings::store::VoiceActivationMode,
) -> Result<(), VoiceErrorView> {
    if !settings.enabled
        || settings.provider != "groq"
        || settings.model != super::types::GROQ_STT_MODEL
        || !settings.privacy_consent
        || settings
            .privacy_consent_at
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        return Err(to_error(VoiceErrorCode::ConsentRequired));
    }
    if activation_mode != crate::settings::store::VoiceActivationMode::WakeWord
        && !provider_configured
    {
        return Err(to_error(VoiceErrorCode::ProviderNotConfigured));
    }
    Ok(())
}

fn to_error(code: VoiceErrorCode) -> VoiceErrorView {
    error_view(code, friendly_message(code))
}

fn emit_voice_state(app: &AppHandle, status: &VoiceRequestStatusView) {
    debug!(
        request_id = %status.request_id,
        workspace_id = %status.workspace_id,
        status = ?status.status,
        error_code = ?status.error.as_ref().map(|error| &error.code),
        transcript_chars = status.transcript.as_deref().map(str::chars).map(Iterator::count),
        "Emitting Jarvis voice state"
    );
    if let Err(error) = app.emit(VOICE_STATE_EVENT, status) {
        warn!(request_id = %status.request_id, error = %error, "Could not emit Jarvis voice state");
    }
}

fn ensure_microphone_unmuted(muted: bool) -> Result<(), VoiceErrorView> {
    if muted {
        Err(to_error(VoiceErrorCode::MicrophoneMuted))
    } else {
        Ok(())
    }
}

fn emit_wake_state(app: &AppHandle, status: &WakeWordStatusView) {
    debug!(
        state = ?status.state,
        enabled = status.enabled,
        keyword = %status.keyword,
        engine = %status.engine,
        error_code = ?status.error.as_ref().map(|error| &error.code),
        "Emitting Jarvis wake-word state"
    );
    if let Err(error) = app.emit(WAKE_STATE_EVENT, status) {
        warn!(error = %error, "Could not emit Jarvis wake-word state");
    }
}

fn emit_tts_state(app: &AppHandle, status: &TtsStatusView) {
    debug!(
        request_id = ?status.request_id,
        status = ?status.status,
        error_code = ?status.error.as_ref().map(|error| &error.code),
        "[JARVIS-TTS] emitting state",
    );
    if let Err(error) = app.emit(TTS_STATE_EVENT, status) {
        warn!(
            request_id = ?status.request_id,
            error = %error,
            "[JARVIS-TTS] state event emit failed",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_input_allowed, ensure_microphone_unmuted};
    use crate::settings::store::{VoiceActivationMode, VoiceInputSettings};

    #[test]
    fn missing_groq_key_is_rejected_before_capture() {
        let mut settings = VoiceInputSettings::default();
        settings.privacy_consent = true;
        settings.privacy_consent_at = Some("now".into());
        assert_eq!(
            ensure_input_allowed(&settings, false, VoiceActivationMode::Vad)
                .unwrap_err()
                .code,
            "voice_provider_not_configured"
        );
    }

    #[test]
    fn wake_word_standby_does_not_require_groq_before_capture() {
        let mut settings = VoiceInputSettings::default();
        settings.privacy_consent = true;
        settings.privacy_consent_at = Some("now".into());
        assert!(ensure_input_allowed(&settings, false, VoiceActivationMode::WakeWord).is_ok());
    }

    #[test]
    fn muted_microphone_is_rejected_before_audio_start() {
        assert_eq!(
            ensure_microphone_unmuted(true).unwrap_err().code,
            "microphone_muted"
        );
        assert!(ensure_microphone_unmuted(false).is_ok());
    }
}
