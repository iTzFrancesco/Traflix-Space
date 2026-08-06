use std::path::PathBuf;

use crate::settings::store::SettingsManager;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::audio::{encode_wav_pcm16, wav_duration_ms};
use super::registry::{friendly_message, VoiceState};
use super::stt::{GroqSpeechToTextProvider, SpeechToTextProvider};
use super::tts::{
    cleanup_temp_file, sanitize_for_speech, EdgeTextToSpeechProvider, TextToSpeechProvider,
};
use super::types::{
    error_view, normalize_max_duration_seconds, TtsSpeakRequest, TtsStatus, TtsStatusView,
    VoiceCancelRequest, VoiceErrorCode, VoiceErrorView, VoiceInputDevice, VoiceLevelEvent,
    VoiceRequestStatus, VoiceRequestStatusView, VoiceStartRequest, VoiceStopRequest,
};

const VOICE_STATE_EVENT: &str = "jarvis://voice-state";
const VOICE_LEVEL_EVENT: &str = "jarvis://voice-level";
const TTS_STATE_EVENT: &str = "jarvis://tts-state";

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
    let status = state
        .start(
            request.request_id,
            request.workspace_id,
            request.selected_device_id,
            max_duration_seconds,
        )
        .map_err(to_error)?;
    emit_voice_state(&app, &status);
    let event_app = app.clone();
    let event_state = (*state).clone();
    let request_id = status.request_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let Some(status) = event_state.snapshot(Some(&request_id)).ok() else {
                break;
            };
            if status.status != VoiceRequestStatus::Recording {
                break;
            }
            let _ = event_app.emit(
                VOICE_LEVEL_EVENT,
                VoiceLevelEvent {
                    request_id: request_id.clone(),
                    elapsed_ms: status.duration_ms.unwrap_or_default(),
                    normalized_level: status.normalized_level,
                },
            );
        }
    });
    let watchdog_app = app.clone();
    let watchdog_state = (*state).clone();
    let mut watchdog_config = configured.jarvis.voice_input.clone();
    watchdog_config.max_duration_seconds = max_duration_seconds;
    let watchdog_request_id = status.request_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(max_duration_seconds as u64)).await;
        if watchdog_state
            .snapshot(Some(&watchdog_request_id))
            .map(|current| current.status == VoiceRequestStatus::Recording)
            .unwrap_or(false)
        {
            let _ = finish_voice_stop(
                &watchdog_app,
                &watchdog_state,
                watchdog_config,
                watchdog_request_id,
            )
            .await;
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
    let (capture, cancellation) = state.begin_stop(&request_id).map_err(to_error)?;
    let audio = capture.stop().map_err(to_error)?;
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
    let helper = helper_path(&app);
    let provider = EdgeTextToSpeechProvider::new(helper);
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
    let mut child = helper_command(helper_path(&app))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| to_error(VoiceErrorCode::HelperFailed))?;
    if let Some(mut stdin) = child.stdin.take() {
        if stdin
            .write_all(
                br#"{"action":"listVoices"}
"#,
            )
            .await
            .is_err()
        {
            let _ = child.kill().await;
            return Err(to_error(VoiceErrorCode::HelperFailed));
        }
    }
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err(to_error(VoiceErrorCode::HelperFailed));
    };
    let status = match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await
    {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            return Err(to_error(VoiceErrorCode::HelperFailed));
        }
    };
    let mut bytes = Vec::new();
    stdout
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| to_error(VoiceErrorCode::HelperFailed))?;
    if !status.success() || bytes.len() > 64 * 1024 {
        return Err(to_error(VoiceErrorCode::HelperFailed));
    }
    let result: VoiceListResult =
        serde_json::from_slice(&bytes).map_err(|_| to_error(VoiceErrorCode::HelperFailed))?;
    if !result.ok {
        return Err(to_error(VoiceErrorCode::HelperFailed));
    }
    Ok(result.voices.unwrap_or_default())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceListResult {
    ok: bool,
    voices: Option<Vec<TtsVoice>>,
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

fn helper_path(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Ok(path) = std::env::var("TRAF_EDGE_TTS_HELPER") {
            return PathBuf::from(path);
        }
        return app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("scripts/jarvis-edge-tts.py");
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let candidates = if cfg!(windows) {
        vec![
            resource_dir.join("binaries/jarvis-edge-tts-x86_64-pc-windows-msvc.exe"),
            resource_dir.join("binaries/jarvis-edge-tts.exe"),
            resource_dir.join("jarvis-edge-tts.exe"),
        ]
    } else {
        vec![resource_dir.join("binaries/jarvis-edge-tts")]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| resource_dir.join("binaries/jarvis-edge-tts"))
}

fn helper_command(path: PathBuf) -> tokio::process::Command {
    if path.extension().and_then(|value| value.to_str()) == Some("exe") {
        let command = tokio::process::Command::new(path);
        command
    } else {
        let mut command =
            tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.arg("-u").arg(path);
        command
    }
}

fn to_error(code: VoiceErrorCode) -> VoiceErrorView {
    error_view(code, friendly_message(code))
}
fn emit_voice_state(app: &AppHandle, status: &VoiceRequestStatusView) {
    let _ = app.emit(VOICE_STATE_EVENT, status);
}
fn emit_tts_state(app: &AppHandle, status: &TtsStatusView) {
    let _ = app.emit(TTS_STATE_EVENT, status);
}

#[cfg(test)]
mod tests {
    use super::ensure_input_allowed;
    use crate::settings::store::VoiceInputSettings;

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
}
