use crate::settings::store::SettingsManager;
use parking_lot::Mutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use super::audio::{encode_wav_pcm16, wav_duration_ms};
use super::registry::{friendly_message, VoiceState};
use super::stt::{GroqSpeechToTextProvider, SpeechToTextProvider};
use super::tts::{
    cleanup_temp_file, sanitize_for_speech, EdgeTextToSpeechProvider, TextToSpeechProvider,
};
use super::types::{
    error_view, normalize_max_duration_seconds, TtsSpeakRequest, TtsStatus, TtsStatusView,
    VoiceCancelRequest, VoiceCaptureOptions, VoiceErrorCode, VoiceErrorView, VoiceInputDevice,
    VoiceLevelEvent, VoiceRequestStatus, VoiceRequestStatusView, VoiceStartRequest,
    VoiceStopRequest,
};

const VOICE_STATE_EVENT: &str = "jarvis://voice-state";
const VOICE_LEVEL_EVENT: &str = "jarvis://voice-level";
const TTS_STATE_EVENT: &str = "jarvis://tts-state";

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
pub async fn jarvis_voice_start(
    app: AppHandle,
    state: State<'_, VoiceState>,
    settings: State<'_, SettingsManager>,
    request: VoiceStartRequest,
) -> Result<VoiceRequestStatusView, VoiceErrorView> {
    let configured = settings.get().await;
    let provider = GroqSpeechToTextProvider::from_environment().map_err(to_error)?;
    ensure_input_allowed(&configured.jarvis.voice_input, provider.configured())?;
    let max_duration_seconds =
        normalize_max_duration_seconds(configured.jarvis.voice_input.max_duration_seconds);
    let input = configured.jarvis.voice_input.clone();
    let options = VoiceCaptureOptions {
        activation_mode: input.activation_mode,
        max_duration_seconds,
        max_armed_seconds: input.max_armed_seconds,
        vad_enabled: input.vad_enabled
            || input.activation_mode == crate::settings::store::VoiceActivationMode::Vad,
        vad_speech_threshold: input.vad_speech_threshold,
        vad_start_frames: input.vad_start_frames,
        vad_silence_frames: input.vad_silence_frames,
        vad_pre_roll_ms: input.vad_pre_roll_ms,
        vad_post_speech_ms: input.vad_post_speech_ms,
    }
    .bounded();
    let status = state
        .start(
            request.request_id,
            request.workspace_id,
            request.selected_device_id,
            options,
        )
        .map_err(to_error)?;
    emit_voice_state(&app, &status);
    let mut watchdog_config = configured.jarvis.voice_input.clone();
    watchdog_config.max_duration_seconds = max_duration_seconds;
    watchdog_config.max_armed_seconds = options.max_armed_seconds;
    let level_config = watchdog_config.clone();
    let event_app = app.clone();
    let event_state = (*state).clone();
    let request_id = status.request_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let Ok(signal) = event_state.signal(&request_id) else {
                break;
            };
            let status = signal.status;
            if signal.status_changed {
                emit_voice_state(&event_app, &status);
                stop_tts_on_speech(&event_app, &event_state, &status);
            }
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
            if signal.should_stop && status.status == VoiceRequestStatus::Recording {
                let _ = finish_voice_stop(
                    &event_app,
                    &event_state,
                    level_config.clone(),
                    request_id.clone(),
                )
                .await;
                break;
            }
        }
    });
    let watchdog_app = app.clone();
    let watchdog_state = (*state).clone();
    let watchdog_request_id = status.request_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let Ok(signal) = watchdog_state.signal(&watchdog_request_id) else {
                break;
            };
            let current = signal.status;
            if signal.status_changed {
                emit_voice_state(&watchdog_app, &current);
                stop_tts_on_speech(&watchdog_app, &watchdog_state, &current);
            }
            if current.status == VoiceRequestStatus::Armed {
                if current.duration_ms.unwrap_or_default()
                    >= watchdog_config.max_armed_seconds as u64 * 1000
                {
                    if let Ok(status) = watchdog_state.timeout_armed(&watchdog_request_id) {
                        emit_voice_state(&watchdog_app, &status);
                    }
                    break;
                }
            } else if current.status == VoiceRequestStatus::Recording
                && current.duration_ms.unwrap_or_default() >= max_duration_seconds as u64 * 1000
            {
                let _ = finish_voice_stop(
                    &watchdog_app,
                    &watchdog_state,
                    watchdog_config.clone(),
                    watchdog_request_id.clone(),
                )
                .await;
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
    let signal = state.signal(&request_id).map_err(to_error)?;
    if signal.status_changed {
        emit_voice_state(app, &signal.status);
    }
    if signal.status.status == VoiceRequestStatus::Failed {
        return Ok(signal.status);
    }
    if signal.status.status == VoiceRequestStatus::Armed {
        let status = state.stop_armed(&request_id).map_err(to_error)?;
        emit_voice_state(app, &status);
        return Ok(status);
    }
    let (capture, cancellation, transcribing) = match state.begin_stop(&request_id) {
        Ok(result) => result,
        Err(VoiceErrorCode::InvalidRequest) => {
            let current = state.snapshot(Some(&request_id)).map_err(to_error)?;
            if matches!(
                current.status,
                VoiceRequestStatus::Transcribing
                    | VoiceRequestStatus::TranscriptReady
                    | VoiceRequestStatus::Cancelled
                    | VoiceRequestStatus::Failed
            ) {
                return Ok(current);
            }
            return Err(to_error(VoiceErrorCode::InvalidRequest));
        }
        Err(code) => return Err(to_error(code)),
    };
    emit_voice_state(app, &transcribing);
    let audio = match capture.stop() {
        Ok(audio) => audio,
        Err(code) => {
            let status = state
                .finish(&request_id, VoiceRequestStatus::Failed, None, Some(code))
                .map_err(to_error)?;
            emit_voice_state(app, &status);
            return Ok(status);
        }
    };
    if cancellation.is_cancelled() {
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
        Ok(wav) => wav,
        Err(code) => {
            let status = state
                .finish(&request_id, VoiceRequestStatus::Failed, None, Some(code))
                .map_err(to_error)?;
            emit_voice_state(app, &status);
            return Ok(status);
        }
    };
    let duration_ms = wav_duration_ms(&wav);
    let provider = GroqSpeechToTextProvider::from_environment().map_err(to_error)?;
    if !provider.configured() {
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
    let result = provider
        .transcribe(wav, config.language, cancellation)
        .await;
    let (next_status, transcript, error) = match result {
        Ok(text) => (VoiceRequestStatus::TranscriptReady, Some(text), None),
        Err(code) => (
            if code == VoiceErrorCode::Cancelled {
                VoiceRequestStatus::Cancelled
            } else {
                VoiceRequestStatus::Failed
            },
            None,
            Some(code),
        ),
    };
    let mut status = state
        .finish(&request_id, next_status, transcript, error)
        .map_err(to_error)?;
    if let Some(duration) = duration_ms {
        status.duration_ms = Some(duration);
    }
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
    let config = settings.get().await.jarvis.voice_output;
    ensure_output_allowed(&config)?;
    let text = sanitize_for_speech(&request.text, config.max_spoken_chars)
        .ok_or_else(|| to_error(VoiceErrorCode::InvalidRequest))?;
    let request_id = request.request_id.clone();
    let (cancellation, synthesizing) = state.begin_tts(request_id.clone());
    emit_tts_state(&app, &synthesizing);
    let provider = runtime_tts_provider(&app);
    let path = match provider
        .speak(
            request_id.clone(),
            text,
            request.voice.unwrap_or(config.voice),
            request.rate.unwrap_or(config.rate),
            request.volume.unwrap_or(config.volume),
            request.pitch.unwrap_or(config.pitch),
            config.max_spoken_chars,
            cancellation.clone(),
        )
        .await
    {
        Ok(path) => path,
        Err(code) => {
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
    if let Some(status) = state.set_tts_for(&request_id, TtsStatus::Playing, None) {
        emit_tts_state(&app, &status);
    } else {
        cleanup_temp_file(&path);
        return Ok(state.tts_status());
    }
    let playback = state.playback.play(path.clone(), cancellation).await;
    cleanup_temp_file(&path);
    match playback {
        Ok(()) => {
            if let Some(status) = state.set_tts_for(&request_id, TtsStatus::Idle, None) {
                emit_tts_state(&app, &status);
                Ok(status)
            } else {
                Ok(state.tts_status())
            }
        }
        Err(code) => {
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
    emit_tts_state(&app, &status);
    state.wait_tts_request_finished(request_id).await;
    Ok(state.tts_status())
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
    if !settings.enabled
        || settings.provider != "edge_tts"
        || !settings.privacy_consent
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
    let _ = app.emit(VOICE_STATE_EVENT, status);
}
fn emit_tts_state(app: &AppHandle, status: &TtsStatusView) {
    let _ = app.emit(TTS_STATE_EVENT, status);
}

/// Barge-in is handled at the audio boundary, not only through a React event
/// round-trip. This runs once when VAD confirms speech and cancels the active
/// Edge TTS/playback token before the first spoken frame can pollute STT.
fn stop_tts_on_speech(app: &AppHandle, state: &VoiceState, status: &VoiceRequestStatusView) {
    if status.status != VoiceRequestStatus::Recording {
        return;
    }
    let (tts, request_id) = state.request_stop_tts();
    if request_id.is_some() {
        emit_tts_state(app, &tts);
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_input_allowed, reconcile_shortcut, validate_shortcut, ShortcutRegistrar};
    use crate::jarvis::voice::types::VoiceErrorCode;
    use crate::settings::store::VoiceInputSettings;

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
