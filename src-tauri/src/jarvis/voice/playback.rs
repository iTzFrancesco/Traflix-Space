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
impl AudioPlayback for PlatformAudioPlayback {
    fn play(&self, path: PathBuf, cancellation: CancellationToken) -> PlaybackFuture {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                use rodio::{Decoder, OutputStream, Sink};
                use std::fs::File;
                use std::io::BufReader;
                let (_stream, handle) =
                    OutputStream::try_default().map_err(|_| VoiceErrorCode::PlaybackFailed)?;
                let sink = Sink::try_new(&handle).map_err(|_| VoiceErrorCode::PlaybackFailed)?;
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
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Ok(())
            })
            .await
            .map_err(|_| VoiceErrorCode::PlaybackFailed)?
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
