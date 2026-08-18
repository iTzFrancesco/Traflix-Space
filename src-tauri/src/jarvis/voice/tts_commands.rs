use crate::settings::store::SettingsManager;
use tauri::{AppHandle, State};
use tracing::{info, warn};

use super::super::playback::PlaybackContext;
use super::super::registry::VoiceState;
use super::super::tts::{
    cleanup_temp_file, normalize_for_speech, EdgeTextToSpeechProvider, TextToSpeechProvider,
};
use super::super::types::{
    TtsSpeakRequest, TtsStatus, TtsStatusView, VoiceErrorCode, VoiceErrorView,
};
use super::{emit_tts_state, to_error};

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
