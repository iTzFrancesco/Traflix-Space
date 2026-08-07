use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use tokio_util::sync::CancellationToken;

use super::types::VoiceErrorCode;

pub type PlaybackFuture = Pin<Box<dyn Future<Output = Result<(), VoiceErrorCode>> + Send>>;

pub trait AudioPlayback: Send + Sync {
    fn play(&self, path: PathBuf, cancellation: CancellationToken) -> PlaybackFuture;
}

#[derive(Default)]
pub struct PlatformAudioPlayback;

#[cfg(not(windows))]
impl AudioPlayback for PlatformAudioPlayback {
    fn play(&self, _path: PathBuf, _cancellation: CancellationToken) -> PlaybackFuture {
        Box::pin(async { Err(VoiceErrorCode::PlaybackFailed) })
    }
}

#[cfg(windows)]
enum PlaybackRequest {
    Play {
        path: PathBuf,
        cancellation: CancellationToken,
        response: tokio::sync::oneshot::Sender<Result<(), VoiceErrorCode>>,
    },
}

#[cfg(windows)]
fn playback_sender() -> &'static std::sync::mpsc::Sender<PlaybackRequest> {
    use std::sync::{mpsc, OnceLock};

    static WORKER: OnceLock<mpsc::Sender<PlaybackRequest>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<PlaybackRequest>();
        std::thread::Builder::new()
            .name("traflix-tts-playback".into())
            .spawn(move || playback_loop(receiver))
            .expect("TTS playback worker");
        sender
    })
}

#[cfg(windows)]
fn playback_loop(receiver: std::sync::mpsc::Receiver<PlaybackRequest>) {
    use rodio::{Decoder, OutputStream, Sink};
    use std::fs::File;
    use std::io::BufReader;

    // Keep the Windows output device open across replies. Reopening the audio
    // device for every short Jarvis sentence adds perceptible start latency on
    // some drivers even when synthesis has already completed.
    let output = OutputStream::try_default().ok();
    let Some((_stream, handle)) = output else {
        while let Ok(PlaybackRequest::Play { response, .. }) = receiver.recv() {
            let _ = response.send(Err(VoiceErrorCode::PlaybackFailed));
        }
        return;
    };

    while let Ok(request) = receiver.recv() {
        match request {
            PlaybackRequest::Play {
                path,
                cancellation,
                response,
            } => {
                let result = (|| {
                    let sink =
                        Sink::try_new(&handle).map_err(|_| VoiceErrorCode::PlaybackFailed)?;
                    let file = File::open(&path).map_err(|_| VoiceErrorCode::PlaybackFailed)?;
                    sink.append(
                        Decoder::new(BufReader::new(file))
                            .map_err(|_| VoiceErrorCode::PlaybackFailed)?,
                    );
                    while !sink.empty() {
                        if cancellation.is_cancelled() {
                            sink.stop();
                            return Err(VoiceErrorCode::Cancelled);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(8));
                    }
                    Ok(())
                })();
                let _ = response.send(result);
            }
        }
    }
}

#[cfg(windows)]
impl AudioPlayback for PlatformAudioPlayback {
    fn play(&self, path: PathBuf, cancellation: CancellationToken) -> PlaybackFuture {
        Box::pin(async move {
            let (response, result) = tokio::sync::oneshot::channel();
            playback_sender()
                .send(PlaybackRequest::Play {
                    path,
                    cancellation,
                    response,
                })
                .map_err(|_| VoiceErrorCode::PlaybackFailed)?;
            result.await.map_err(|_| VoiceErrorCode::PlaybackFailed)?
        })
    }
}

#[cfg(test)]
pub struct FakePlayback;

#[cfg(test)]
impl AudioPlayback for FakePlayback {
    fn play(&self, _path: PathBuf, cancellation: CancellationToken) -> PlaybackFuture {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                Err(VoiceErrorCode::Cancelled)
            } else {
                Ok(())
            }
        })
    }
}
