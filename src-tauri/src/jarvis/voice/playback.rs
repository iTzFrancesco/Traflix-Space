use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use tracing::{debug, error, info, warn};

use super::types::VoiceErrorCode;

pub type PlaybackFuture = Pin<Box<dyn Future<Output = Result<(), VoiceErrorCode>> + Send>>;

#[derive(Clone, Debug)]
pub struct PlaybackContext {
    pub request_id: String,
    pub workspace_id: Option<String>,
}

pub trait AudioPlayback: Send + Sync {
    fn play(
        &self,
        context: PlaybackContext,
        path: PathBuf,
        cancellation: CancellationToken,
    ) -> PlaybackFuture;
}

#[cfg(any(windows, test))]
fn ensure_cached<T, E>(
    cached: &mut Option<T>,
    open: impl FnOnce() -> Result<T, E>,
) -> Result<(), E> {
    if cached.is_none() {
        *cached = Some(open()?);
    }
    Ok(())
}

#[derive(Default)]
pub struct PlatformAudioPlayback;

#[cfg(not(windows))]
impl AudioPlayback for PlatformAudioPlayback {
    fn play(
        &self,
        context: PlaybackContext,
        _path: PathBuf,
        _cancellation: CancellationToken,
    ) -> PlaybackFuture {
        Box::pin(async move {
            tracing::warn!(
                request_id = %context.request_id,
                workspace_id = ?context.workspace_id,
                error_code = %VoiceErrorCode::PlaybackFailed.as_str(),
                "[JARVIS-TTS-PLAYBACK] playback requested on unsupported platform",
            );
            Err(VoiceErrorCode::PlaybackFailed)
        })
    }
}

#[cfg(windows)]
enum PlaybackRequest {
    Play {
        context: PlaybackContext,
        path: PathBuf,
        cancellation: CancellationToken,
        response: tokio::sync::oneshot::Sender<Result<(), VoiceErrorCode>>,
    },
}

#[cfg(windows)]
fn playback_worker_slot(
) -> &'static std::sync::Mutex<Option<std::sync::mpsc::Sender<PlaybackRequest>>> {
    use std::sync::{Mutex, OnceLock};

    static WORKER: OnceLock<Mutex<Option<std::sync::mpsc::Sender<PlaybackRequest>>>> =
        OnceLock::new();
    WORKER.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn playback_sender() -> Result<std::sync::mpsc::Sender<PlaybackRequest>, VoiceErrorCode> {
    use std::sync::mpsc;

    let mut current = playback_worker_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(sender) = current.as_ref() {
        return Ok(sender.clone());
    }
    let (sender, receiver) = mpsc::channel::<PlaybackRequest>();
    std::thread::Builder::new()
        .name("traflix-tts-playback".into())
        .spawn(move || playback_loop(receiver))
        .map_err(|error| {
            error!(
                error = %error,
                error_code = %VoiceErrorCode::PlaybackFailed.as_str(),
                "[JARVIS-TTS-PLAYBACK] playback worker could not be started",
            );
            VoiceErrorCode::PlaybackFailed
        })?;
    *current = Some(sender.clone());
    Ok(sender)
}

#[cfg(windows)]
fn reset_playback_sender() {
    let mut current = playback_worker_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    current.take();
}

#[cfg(windows)]
fn playback_loop(receiver: std::sync::mpsc::Receiver<PlaybackRequest>) {
    use rodio::{OutputStream, OutputStreamHandle};

    info!("[JARVIS-TTS-PLAYBACK] playback worker starting");
    // Cache a healthy stream to avoid driver startup latency, but never cache
    // an unavailable device. A later request must be able to recover after a
    // headset/default-device transition.
    let mut output: Option<(OutputStream, OutputStreamHandle)> = None;

    while let Ok(request) = receiver.recv() {
        match request {
            PlaybackRequest::Play {
                context,
                path,
                cancellation,
                response,
            } => {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown");
                debug!(
                    request_id = %context.request_id,
                    workspace_id = ?context.workspace_id,
                    file_name,
                    "[JARVIS-TTS-PLAYBACK] playback request received",
                );
                let result =
                    play_on_windows(&mut output, &context, &path, file_name, &cancellation);
                if let Err(code) = result {
                    warn!(
                        request_id = %context.request_id,
                        workspace_id = ?context.workspace_id,
                        file_name,
                        error_code = %code.as_str(),
                        "[JARVIS-TTS-PLAYBACK] playback request failed",
                    );
                    let _ = response.send(Err(code));
                    continue;
                }
                let _ = response.send(result);
            }
        }
    }
}

#[cfg(windows)]
fn play_on_windows(
    output: &mut Option<(rodio::OutputStream, rodio::OutputStreamHandle)>,
    context: &PlaybackContext,
    path: &std::path::Path,
    file_name: &str,
    cancellation: &CancellationToken,
) -> Result<(), VoiceErrorCode> {
    use rodio::{Decoder, OutputStream, Sink};
    use std::fs::File;
    use std::io::BufReader;

    for device_attempt in 1..=2 {
        let opening_device = output.is_none();
        if let Err(error) = ensure_cached(output, OutputStream::try_default) {
            warn!(
                request_id = %context.request_id,
                workspace_id = ?context.workspace_id,
                device_attempt,
                error = %error,
                error_code = %VoiceErrorCode::PlaybackDeviceUnavailable.as_str(),
                "[JARVIS-TTS-PLAYBACK] Windows output device could not be opened",
            );
            if device_attempt == 1 {
                continue;
            }
            return Err(VoiceErrorCode::PlaybackDeviceUnavailable);
        }
        if opening_device {
            info!(
                request_id = %context.request_id,
                workspace_id = ?context.workspace_id,
                device_attempt,
                "[JARVIS-TTS-PLAYBACK] Windows output device opened",
            );
        }

        let sink_result = match output.as_ref() {
            Some((_stream, handle)) => Sink::try_new(handle),
            None => return Err(VoiceErrorCode::PlaybackDeviceUnavailable),
        };
        let sink = match sink_result {
            Ok(sink) => sink,
            Err(error) => {
                warn!(
                    request_id = %context.request_id,
                    workspace_id = ?context.workspace_id,
                    device_attempt,
                    error = %error,
                    error_code = %VoiceErrorCode::PlaybackDeviceUnavailable.as_str(),
                    "[JARVIS-TTS-PLAYBACK] audio sink could not be created; reopening device",
                );
                output.take();
                if device_attempt == 1 {
                    continue;
                }
                return Err(VoiceErrorCode::PlaybackDeviceUnavailable);
            }
        };
        let file = File::open(path).map_err(|error| {
            error!(
                request_id = %context.request_id,
                workspace_id = ?context.workspace_id,
                file_name,
                error = %error,
                error_code = %VoiceErrorCode::TtsAudioFileInvalid.as_str(),
                "[JARVIS-TTS-PLAYBACK] generated audio file could not be opened",
            );
            VoiceErrorCode::TtsAudioFileInvalid
        })?;
        sink.append(Decoder::new(BufReader::new(file)).map_err(|error| {
            error!(
                request_id = %context.request_id,
                workspace_id = ?context.workspace_id,
                file_name,
                error = %error,
                error_code = %VoiceErrorCode::TtsAudioDecodeFailed.as_str(),
                "[JARVIS-TTS-PLAYBACK] generated audio could not be decoded",
            );
            VoiceErrorCode::TtsAudioDecodeFailed
        })?);
        info!(
            request_id = %context.request_id,
            workspace_id = ?context.workspace_id,
            file_name,
            "[JARVIS-TTS-PLAYBACK] playback started",
        );
        let started = std::time::Instant::now();
        while !sink.empty() {
            if cancellation.is_cancelled() {
                sink.stop();
                info!(
                    request_id = %context.request_id,
                    workspace_id = ?context.workspace_id,
                    file_name,
                    "[JARVIS-TTS-PLAYBACK] playback cancelled",
                );
                return Err(VoiceErrorCode::Cancelled);
            }
            if started.elapsed() >= std::time::Duration::from_secs(180) {
                sink.stop();
                warn!(
                    request_id = %context.request_id,
                    workspace_id = ?context.workspace_id,
                    file_name,
                    error_code = %VoiceErrorCode::TtsTimeout.as_str(),
                    "[JARVIS-TTS-PLAYBACK] playback exceeded bounded duration",
                );
                return Err(VoiceErrorCode::TtsTimeout);
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        debug!(
            request_id = %context.request_id,
            workspace_id = ?context.workspace_id,
            file_name,
            "[JARVIS-TTS-PLAYBACK] playback buffer drained",
        );
        return Ok(());
    }
    Err(VoiceErrorCode::PlaybackDeviceUnavailable)
}

#[cfg(windows)]
impl AudioPlayback for PlatformAudioPlayback {
    fn play(
        &self,
        context: PlaybackContext,
        path: PathBuf,
        cancellation: CancellationToken,
    ) -> PlaybackFuture {
        Box::pin(async move {
            for worker_attempt in 1..=2 {
                if cancellation.is_cancelled() {
                    return Err(VoiceErrorCode::Cancelled);
                }
                let sender = playback_sender()?;
                let (response, result) = tokio::sync::oneshot::channel();
                if sender
                    .send(PlaybackRequest::Play {
                        context: context.clone(),
                        path: path.clone(),
                        cancellation: cancellation.clone(),
                        response,
                    })
                    .is_err()
                {
                    warn!(
                        request_id = %context.request_id,
                        workspace_id = ?context.workspace_id,
                        worker_attempt,
                        "[JARVIS-TTS-PLAYBACK] playback worker channel closed before dispatch",
                    );
                    reset_playback_sender();
                    continue;
                }
                match result.await {
                    Ok(playback) => return playback,
                    Err(error) => {
                        warn!(
                            request_id = %context.request_id,
                            workspace_id = ?context.workspace_id,
                            worker_attempt,
                            error = %error,
                            "[JARVIS-TTS-PLAYBACK] playback worker response channel closed",
                        );
                        reset_playback_sender();
                    }
                }
            }
            Err(VoiceErrorCode::PlaybackFailed)
        })
    }
}

#[cfg(test)]
pub struct FakePlayback;

#[cfg(test)]
impl AudioPlayback for FakePlayback {
    fn play(
        &self,
        _context: PlaybackContext,
        _path: PathBuf,
        cancellation: CancellationToken,
    ) -> PlaybackFuture {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                Err(VoiceErrorCode::Cancelled)
            } else {
                Ok(())
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_cached;

    #[test]
    fn failed_device_open_is_not_cached_and_next_request_reopens() {
        let mut cached = None;
        let mut attempts = 0;
        let first = ensure_cached(&mut cached, || {
            attempts += 1;
            Err::<u8, _>("temporarily unavailable")
        });
        assert!(first.is_err());
        assert!(cached.is_none());

        ensure_cached(&mut cached, || {
            attempts += 1;
            Ok::<_, &str>(7)
        })
        .unwrap();
        assert_eq!(cached, Some(7));
        assert_eq!(attempts, 2);
    }
}
