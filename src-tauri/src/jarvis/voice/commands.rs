use crate::settings::store::SettingsManager;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tracing::{debug, error, info, warn};

use super::audio::{encode_wav_pcm16, wav_duration_ms};
use super::endpointing::{EndpointingConfig, EndpointingController, EndpointingDecision};
use super::playback::PlaybackContext;
use super::registry::{friendly_message, VoiceState};
use super::stt::{GroqSpeechToTextProvider, SpeechToTextProvider};
use super::tts::{
    cleanup_temp_file, normalize_for_speech, EdgeTextToSpeechProvider, TextToSpeechProvider,
};
use super::types::{
    error_view, normalize_max_duration_seconds, TtsSpeakRequest, TtsStatus, TtsStatusView,
    VoiceCancelRequest, VoiceCaptureOptions, VoiceErrorCode, VoiceErrorView, VoiceInputDevice,
    VoiceLevelEvent, VoiceRequestStatus, VoiceRequestStatusView, VoiceStartRequest,
    VoiceStopRequest, WakeWordStatusView,
};
use super::vad::VadState;
use super::wake::{self, WakeWordConfig};

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
pub async fn jarvis_voice_sync_shortcut(
    app: AppHandle,
    settings: State<'_, SettingsManager>,
) -> Result<(), VoiceErrorView> {
    let configured = settings.get().await;
    let shortcut = configured.jarvis.voice_input.global_shortcut.trim();
    let enabled =
        configured.jarvis.enabled && configured.jarvis.voice_input.global_shortcut_enabled;
    let mut registered = registered_shortcut().lock();
    let registrar = TauriShortcutRegistrar { app: &app };
    reconcile_shortcut(&registrar, &mut registered, enabled, shortcut).map_err(to_error)
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
    );
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
    crate::settings::secrets::refresh_dotenv_environment(&app);
    let provider = GroqSpeechToTextProvider::from_environment().map_err(|code| {
        warn!(request_id = %request.request_id, error_code = %code.as_str(), "Voice provider configuration lookup failed");
        to_error(code)
    })?;
    debug!(
        request_id = %request.request_id,
        provider_configured = provider.configured(),
        activation_mode = ?configured.jarvis.voice_input.activation_mode,
        vad_enabled = configured.jarvis.voice_input.vad_enabled,
        "Voice start configuration resolved"
    );
    ensure_input_allowed(&configured.jarvis.voice_input, provider.configured()).inspect_err(|error| {
        warn!(request_id = %request.request_id, error_code = %error.code, "Voice start rejected by input policy");
    })?;
    let max_duration_seconds =
        normalize_max_duration_seconds(configured.jarvis.voice_input.max_duration_seconds);
    let input = configured.jarvis.voice_input.clone();
    let activation_mode = request.activation_mode.unwrap_or(input.activation_mode);
    let options = VoiceCaptureOptions {
        activation_mode,
        max_duration_seconds,
        max_armed_seconds: input.max_armed_seconds,
        vad_enabled: input.vad_enabled
            || activation_mode == crate::settings::store::VoiceActivationMode::Vad
            || activation_mode == crate::settings::store::VoiceActivationMode::WakeWord,
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
    );
    let wake_engine = if activation_mode == crate::settings::store::VoiceActivationMode::WakeWord {
        if !configured.jarvis.wake_word_enabled {
            return Err(to_error(VoiceErrorCode::WakeWordDisabled));
        }
        Some(wake::create_engine(&wake_config).map_err(to_error)?)
    } else {
        None
    };
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
    let event_app = app.clone();
    let event_state = (*state).clone();
    let request_id = status.request_id.clone();
    let event_wake_config = wake_config.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let Ok(signal) = event_state.signal(&request_id) else {
                break;
            };
            let status = signal.status;
            if signal.status_changed {
                info!(
                    request_id = %request_id,
                    status = ?status.status,
                    vad_state = ?status.vad_state,
                    level = status.normalized_level,
                    "Voice state changed in capture watchdog"
                );
                emit_voice_state(&event_app, &status);
                if status.activation_mode == crate::settings::store::VoiceActivationMode::WakeWord
                    && status.status == VoiceRequestStatus::Recording
                {
                    emit_wake_state(
                        &event_app,
                        &wake::listening_status(true, &event_wake_config, None),
                    );
                }
            }
            stop_tts_on_speech(&event_app, &event_state, &status);
            if !matches!(
                status.status,
                VoiceRequestStatus::Recording | VoiceRequestStatus::Armed
            ) {
                break;
            }
            let _ = event_app.emit(
                VOICE_LEVEL_EVENT,
                VoiceLevelEvent {
                    request_id: request_id.clone(),
                    elapsed_ms: status.duration_ms.unwrap_or_default(),
                    normalized_level: status.normalized_level,
                    vad_state: status.vad_state,
                },
            );
            // Endpointing is evaluated by the dedicated watchdog below. This
            // loop only publishes level/VAD telemetry and remains responsive
            // during pauses and long requests.
        }
    });
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
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let Ok(signal) = watchdog_state.signal(&watchdog_request_id) else {
                break;
            };
            let current = signal.status;
            if signal.status_changed {
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
            stop_tts_on_speech(&watchdog_app, &watchdog_state, &current);
            if current.status == VoiceRequestStatus::Recording {
                match endpointing.observe(Instant::now(), &current, signal.should_stop) {
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
            } else if current.status == VoiceRequestStatus::Recording
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
            } else if !matches!(
                current.status,
                VoiceRequestStatus::Recording | VoiceRequestStatus::Armed
            ) {
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

#[tauri::command]
pub async fn jarvis_tts_speak(
    app: AppHandle,
    state: State<'_, VoiceState>,
    settings: State<'_, SettingsManager>,
    request: TtsSpeakRequest,
) -> Result<TtsStatusView, VoiceErrorView> {
    let request_id = request.request_id.clone();
    let workspace_id = request.workspace_id.clone();
    let config = settings.get().await.jarvis.voice_output;
    info!(
        request_id = %request_id,
        workspace_id = ?workspace_id,
        input_chars = request.text.chars().count(),
        configured_provider = %config.provider,
        configured_voice = %config.voice,
        auto_speak = config.auto_speak,
        output_enabled = config.enabled,
        "[JARVIS-TTS] speak requested",
    );
    if let Err(error) = ensure_output_allowed(&config) {
        warn!(
            request_id = %request_id,
            workspace_id = ?workspace_id,
            error_code = %error.code,
            "[JARVIS-TTS] speak rejected by output policy",
        );
        return Err(error);
    }
    let text = match normalize_for_speech(&request.text, config.max_spoken_chars) {
        Some(text) => text,
        None => {
            warn!(
                request_id = %request_id,
                workspace_id = ?workspace_id,
                input_chars = request.text.chars().count(),
                max_spoken_chars = config.max_spoken_chars,
                "[JARVIS-TTS] speak rejected after text normalization",
            );
            return Err(to_error(VoiceErrorCode::InvalidRequest));
        }
    };
    let voice = request.voice.unwrap_or(config.voice);
    let rate = request.rate.unwrap_or(config.rate);
    let volume = request.volume.unwrap_or(config.volume);
    let pitch = request.pitch.unwrap_or(config.pitch);
    info!(
        request_id = %request_id,
        workspace_id = ?workspace_id,
        text_chars = text.chars().count(),
        voice = %voice,
        rate = %rate,
        volume = %volume,
        pitch = %pitch,
        runtime = if cfg!(debug_assertions) { "python" } else { "sidecar" },
        "[JARVIS-TTS] synthesis starting",
    );
    let (cancellation, synthesizing) = state.begin_tts(request_id.clone(), workspace_id.clone());
    emit_tts_state(&app, &synthesizing);
    let provider = runtime_tts_provider(&app);
    let path = match provider
        .speak(
            request_id.clone(),
            workspace_id.clone(),
            text,
            voice,
            rate,
            volume,
            pitch,
            cancellation.clone(),
        )
        .await
    {
        Ok(path) => {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown");
            let file_bytes = std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            info!(
                request_id = %request_id,
                workspace_id = ?workspace_id,
                file_name = %file_name,
                file_bytes,
                "[JARVIS-TTS] synthesis completed",
            );
            path
        }
        Err(code) => {
            warn!(
                request_id = %request_id,
                workspace_id = ?workspace_id,
                error_code = %code.as_str(),
                cancelled = code == VoiceErrorCode::Cancelled,
                "[JARVIS-TTS] synthesis failed",
            );
            let status = state.set_tts_for(
                &request_id,
                if code == VoiceErrorCode::Cancelled {
                    TtsStatus::Stopped
                } else {
                    TtsStatus::Failed
                },
                Some(code),
            );
            if let Some(status) = status {
                emit_tts_state(&app, &status);
                return Err(to_error(code));
            }
            return Ok(state.tts_status());
        }
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    info!(
        request_id = %request_id,
        workspace_id = ?workspace_id,
        file_name = %file_name,
        "[JARVIS-TTS] playback starting",
    );
    if let Some(status) = state.set_tts_for(&request_id, TtsStatus::Playing, None) {
        emit_tts_state(&app, &status);
    } else {
        warn!(
            request_id = %request_id,
            workspace_id = ?workspace_id,
            file_name = %file_name,
            "[JARVIS-TTS] playback skipped because request is no longer active",
        );
        cleanup_temp_file(&path);
        return Ok(state.tts_status());
    }
    let playback = state
        .playback
        .play(
            PlaybackContext {
                request_id: request_id.clone(),
                workspace_id: workspace_id.clone(),
            },
            path.clone(),
            cancellation,
        )
        .await;
    cleanup_temp_file(&path);
    match playback {
        Ok(()) => {
            info!(
                request_id = %request_id,
                workspace_id = ?workspace_id,
                file_name = %file_name,
                "[JARVIS-TTS] playback completed",
            );
            if let Some(status) = state.set_tts_for(&request_id, TtsStatus::Idle, None) {
                emit_tts_state(&app, &status);
                Ok(status)
            } else {
                Ok(state.tts_status())
            }
        }
        Err(code) => {
            warn!(
                request_id = %request_id,
                workspace_id = ?workspace_id,
                file_name = %file_name,
                error_code = %code.as_str(),
                cancelled = code == VoiceErrorCode::Cancelled,
                "[JARVIS-TTS] playback failed",
            );
            let status = state.set_tts_for(
                &request_id,
                if code == VoiceErrorCode::Cancelled {
                    TtsStatus::Stopped
                } else {
                    TtsStatus::Failed
                },
                Some(code),
            );
            if let Some(status) = status {
                emit_tts_state(&app, &status);
                if code == VoiceErrorCode::Cancelled {
                    Ok(status)
                } else {
                    Err(to_error(code))
                }
            } else {
                Ok(state.tts_status())
            }
        }
    }
}

#[tauri::command]
pub async fn jarvis_tts_stop(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<TtsStatusView, VoiceErrorView> {
    let (status, request_id) = state.request_stop_tts();
    info!(
        request_id = ?request_id,
        status = ?status.status,
        "[JARVIS-TTS] stop requested",
    );
    emit_tts_state(&app, &status);
    let finished = state.wait_tts_request_finished(request_id.clone()).await;
    if !finished {
        if let Some(request_id) = request_id.as_deref() {
            warn!(
                request_id,
                "[JARVIS-TTS] stop acknowledgement timed out; finalizing cancelled request",
            );
            if let Some(status) = state.finish_stopped_tts(request_id) {
                emit_tts_state(&app, &status);
            }
        }
    }
    let status = state.tts_status();
    info!(
        request_id = ?status.request_id,
        status = ?status.status,
        error_code = ?status.error.as_ref().map(|error| &error.code),
        "[JARVIS-TTS] stop completed",
    );
    Ok(status)
}

#[tauri::command]
pub fn jarvis_tts_status(state: State<'_, VoiceState>) -> TtsStatusView {
    state.tts_status()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    pub short_name: String,
    pub locale: String,
    pub gender: Option<String>,
}

#[tauri::command]
pub async fn jarvis_tts_list_voices(
    app: AppHandle,
    settings: State<'_, SettingsManager>,
) -> Result<Vec<TtsVoice>, VoiceErrorView> {
    let config = settings.get().await.jarvis.voice_output;
    ensure_output_allowed(&config)?;
    let provider = runtime_tts_provider(&app);
    let voices = provider.list_voices().await.map_err(to_error)?;
    Ok(voices
        .into_iter()
        .filter(|voice| voice.locale.to_ascii_lowercase().starts_with("it-"))
        .map(|voice| TtsVoice {
            short_name: voice.short_name,
            locale: voice.locale,
            gender: voice.gender,
        })
        .collect())
}

fn ensure_input_allowed(
    settings: &crate::settings::store::VoiceInputSettings,
    provider_configured: bool,
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
    if !provider_configured {
        return Err(to_error(VoiceErrorCode::ProviderNotConfigured));
    }
    Ok(())
}

fn ensure_output_allowed(
    settings: &crate::settings::store::VoiceOutputSettings,
) -> Result<(), VoiceErrorView> {
    if !settings.enabled {
        return Err(to_error(VoiceErrorCode::TtsDisabled));
    }
    if settings.provider != "edge_tts" {
        return Err(to_error(VoiceErrorCode::TtsProviderInvalid));
    }
    if !settings.privacy_consent
        || settings
            .privacy_consent_at
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        return Err(to_error(VoiceErrorCode::ConsentRequired));
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn runtime_tts_provider(app: &AppHandle) -> EdgeTextToSpeechProvider {
    EdgeTextToSpeechProvider::debug(debug_helper_path(app))
}

#[cfg(not(debug_assertions))]
fn runtime_tts_provider(app: &AppHandle) -> EdgeTextToSpeechProvider {
    EdgeTextToSpeechProvider::release(app.clone())
}

#[cfg(debug_assertions)]
fn debug_helper_path(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(path) = std::env::var("TRAF_EDGE_TTS_HELPER") {
        return std::path::PathBuf::from(path);
    }
    let _ = app;
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/jarvis-edge-tts.py")
}

fn to_error(code: VoiceErrorCode) -> VoiceErrorView {
    error_view(code, friendly_message(code))
}

fn validate_shortcut(shortcut: &str) -> Result<(), VoiceErrorCode> {
    if shortcut.is_empty() || shortcut.len() > 64 || shortcut.chars().any(|ch| ch.is_control()) {
        Err(VoiceErrorCode::ShortcutInvalid)
    } else if shortcut.parse::<Shortcut>().is_err() {
        Err(VoiceErrorCode::ShortcutInvalid)
    } else {
        Ok(())
    }
}

trait ShortcutRegistrar {
    fn register(&self, shortcut: &str) -> Result<(), VoiceErrorCode>;
    fn unregister(&self, shortcut: &str) -> Result<(), VoiceErrorCode>;
}

struct TauriShortcutRegistrar<'a> {
    app: &'a AppHandle,
}

impl ShortcutRegistrar for TauriShortcutRegistrar<'_> {
    fn register(&self, shortcut: &str) -> Result<(), VoiceErrorCode> {
        let shortcut = shortcut
            .parse::<Shortcut>()
            .map_err(|_| VoiceErrorCode::ShortcutInvalid)?;
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(|_| VoiceErrorCode::ShortcutUnavailable)
    }

    fn unregister(&self, shortcut: &str) -> Result<(), VoiceErrorCode> {
        let shortcut = shortcut
            .parse::<Shortcut>()
            .map_err(|_| VoiceErrorCode::ShortcutInvalid)?;
        self.app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|_| VoiceErrorCode::ShortcutUnavailable)
    }
}

fn reconcile_shortcut<R: ShortcutRegistrar>(
    registrar: &R,
    registered: &mut Option<String>,
    enabled: bool,
    requested: &str,
) -> Result<(), VoiceErrorCode> {
    if !enabled {
        if let Some(previous) = registered.clone() {
            registrar.unregister(&previous)?;
            *registered = None;
        }
        return Ok(());
    }
    validate_shortcut(requested)?;
    if registered.as_deref() == Some(requested) {
        return Ok(());
    }
    registrar.register(requested)?;
    if let Some(previous) = registered.as_deref() {
        if let Err(error) = registrar.unregister(previous) {
            let _ = registrar.unregister(requested);
            return Err(error);
        }
    }
    *registered = Some(requested.to_string());
    Ok(())
}

fn registered_shortcut() -> &'static Mutex<Option<String>> {
    static REGISTERED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    REGISTERED.get_or_init(|| Mutex::new(None))
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

/// Barge-in is handled at the audio boundary, not only through a React event
/// round-trip. This runs once when VAD confirms speech and cancels the active
/// Edge TTS/playback token before the first spoken frame can pollute STT.
fn stop_tts_on_speech(app: &AppHandle, state: &VoiceState, status: &VoiceRequestStatusView) {
    if !should_stop_tts_on_speech(status) {
        return;
    }
    let current_tts = state.tts_status();
    let (tts, request_id) =
        state.request_stop_tts_if_current(current_tts.request_id.as_deref(), current_tts.sequence);
    if request_id.is_some() {
        info!(request_id = ?request_id, "Stopping TTS because VAD confirmed user speech");
        emit_tts_state(app, &tts);
    }
}

fn should_stop_tts_on_speech(status: &VoiceRequestStatusView) -> bool {
    status.status == VoiceRequestStatus::Recording && status.vad_state == VadState::Speech
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_input_allowed, ensure_microphone_unmuted, reconcile_shortcut,
        should_stop_tts_on_speech, validate_shortcut, ShortcutRegistrar,
    };
    use crate::jarvis::voice::types::{VoiceErrorCode, VoiceRequestStatus, VoiceRequestStatusView};
    use crate::jarvis::voice::vad::VadState;
    use crate::settings::store::{VoiceActivationMode, VoiceInputSettings};

    struct MockShortcutRegistrar {
        fail_register: bool,
        fail_unregister: bool,
        operations: std::sync::Mutex<Vec<String>>,
    }

    impl ShortcutRegistrar for MockShortcutRegistrar {
        fn register(&self, shortcut: &str) -> Result<(), VoiceErrorCode> {
            self.operations
                .lock()
                .unwrap()
                .push(format!("register:{shortcut}"));
            if self.fail_register {
                Err(VoiceErrorCode::ShortcutUnavailable)
            } else {
                Ok(())
            }
        }

        fn unregister(&self, shortcut: &str) -> Result<(), VoiceErrorCode> {
            self.operations
                .lock()
                .unwrap()
                .push(format!("unregister:{shortcut}"));
            if self.fail_unregister {
                Err(VoiceErrorCode::ShortcutUnavailable)
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn missing_groq_key_is_rejected_before_capture() {
        let mut settings = VoiceInputSettings::default();
        settings.privacy_consent = true;
        settings.privacy_consent_at = Some("now".into());
        assert_eq!(
            ensure_input_allowed(&settings, false).unwrap_err().code,
            "voice_provider_not_configured"
        );
    }

    #[test]
    fn muted_microphone_is_rejected_before_audio_start() {
        assert_eq!(
            ensure_microphone_unmuted(true).unwrap_err().code,
            "microphone_muted"
        );
        assert!(ensure_microphone_unmuted(false).is_ok());
    }

    #[test]
    fn barge_in_requires_real_speech_and_never_uses_terminal_voice_states() {
        let mut status = VoiceRequestStatusView {
            request_id: "request".into(),
            workspace_id: "workspace".into(),
            selected_device_id: None,
            status: VoiceRequestStatus::Armed,
            created_at: "now".into(),
            started_at: Some("now".into()),
            duration_ms: Some(100),
            normalized_level: 0.2,
            transcript: None,
            error: None,
            activation_mode: VoiceActivationMode::Vad,
            vad_state: VadState::Speech,
        };
        assert!(!should_stop_tts_on_speech(&status));

        status.status = VoiceRequestStatus::Recording;
        status.vad_state = VadState::Silence;
        assert!(!should_stop_tts_on_speech(&status));

        status.vad_state = VadState::Speech;
        assert!(should_stop_tts_on_speech(&status));
    }

    #[test]
    fn shortcut_validation_is_bounded_without_registering_a_real_global_hotkey() {
        assert!(validate_shortcut("Ctrl+Alt+Space").is_ok());
        assert!(validate_shortcut("").is_err());
        assert!(validate_shortcut("Ctrl\nAlt").is_err());
        assert!(validate_shortcut("not-a-shortcut").is_err());
        assert!(validate_shortcut(&"X".repeat(65)).is_err());
    }

    #[test]
    fn shortcut_registration_keeps_previous_on_conflict_and_invalid_input() {
        let conflict = MockShortcutRegistrar {
            fail_register: true,
            fail_unregister: false,
            operations: std::sync::Mutex::new(Vec::new()),
        };
        let mut registered = Some("Ctrl+Alt+Space".to_string());
        assert_eq!(
            reconcile_shortcut(&conflict, &mut registered, true, "Ctrl+Shift+Space"),
            Err(VoiceErrorCode::ShortcutUnavailable)
        );
        assert_eq!(registered.as_deref(), Some("Ctrl+Alt+Space"));

        let valid = MockShortcutRegistrar {
            fail_register: false,
            fail_unregister: false,
            operations: std::sync::Mutex::new(Vec::new()),
        };
        assert_eq!(
            reconcile_shortcut(&valid, &mut registered, true, "invalid"),
            Err(VoiceErrorCode::ShortcutInvalid)
        );
        assert_eq!(registered.as_deref(), Some("Ctrl+Alt+Space"));
    }

    #[test]
    fn shortcut_disable_unregisters_only_the_jarvis_shortcut() {
        let registrar = MockShortcutRegistrar {
            fail_register: false,
            fail_unregister: false,
            operations: std::sync::Mutex::new(Vec::new()),
        };
        let mut registered = Some("Ctrl+Alt+Space".to_string());
        reconcile_shortcut(&registrar, &mut registered, false, "ignored").unwrap();
        assert_eq!(registered, None);
        assert_eq!(
            registrar.operations.lock().unwrap().as_slice(),
            ["unregister:Ctrl+Alt+Space"]
        );
    }
}
