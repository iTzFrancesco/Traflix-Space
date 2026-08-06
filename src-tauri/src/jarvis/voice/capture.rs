use std::sync::{Arc, Mutex};
#[cfg(any(windows, test))]
use std::time::Instant;

use super::types::{CapturedAudio, VoiceErrorCode, VoiceInputDevice, MAX_RECORDING_MS};

pub trait AudioCaptureSession: Send {
    fn stop(self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode>;
    fn elapsed_ms(&self) -> u64;
    fn normalized_level(&self) -> f32;
}

pub trait AudioCaptureSource: Send + Sync {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode>;
    fn start(
        &self,
        selected_device_id: Option<&str>,
        max_duration_seconds: u32,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode>;
}

#[derive(Default)]
pub struct PlatformAudioCapture;

#[cfg(not(windows))]
impl AudioCaptureSource for PlatformAudioCapture {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode> {
        Ok(Vec::new())
    }
    fn start(
        &self,
        _selected_device_id: Option<&str>,
        _max_duration_seconds: u32,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode> {
        Err(VoiceErrorCode::DeviceUnavailable)
    }
}

#[cfg(windows)]
impl AudioCaptureSource for PlatformAudioCapture {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let default_name = host
            .default_input_device()
            .and_then(|device| device.name().ok());
        let devices = host
            .input_devices()
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)?;
        Ok(devices
            .filter_map(|device| {
                let name = device.name().ok()?;
                Some(VoiceInputDevice {
                    id: name.clone(),
                    is_default: default_name.as_deref() == Some(name.as_str()),
                    name,
                    available: true,
                })
            })
            .collect())
    }

    fn start(
        &self,
        selected_device_id: Option<&str>,
        max_duration_seconds: u32,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let device = if let Some(selected) = selected_device_id {
            host.input_devices()
                .map_err(|_| VoiceErrorCode::DeviceUnavailable)?
                .find(|candidate| candidate.name().ok().as_deref() == Some(selected))
                .ok_or(VoiceErrorCode::DeviceUnavailable)?
        } else {
            host.default_input_device()
                .ok_or(VoiceErrorCode::DeviceUnavailable)?
        };
        let supported = device
            .default_input_config()
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)?;
        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels();
        let buffer = Arc::new(Mutex::new(CaptureBuffer::new(
            channels,
            sample_rate,
            max_duration_seconds,
        )));
        let callback_buffer = Arc::clone(&buffer);
        let config: cpal::StreamConfig = supported.clone().into();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| push_samples(&callback_buffer, data.iter().copied()),
                |_error| {},
                None,
            ),
            cpal::SampleFormat::I16 => {
                let callback_buffer = Arc::clone(&buffer);
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        push_samples(
                            &callback_buffer,
                            data.iter()
                                .map(|sample| super::audio::normalize_i16(*sample)),
                        )
                    },
                    |_error| {},
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let callback_buffer = Arc::clone(&buffer);
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        push_samples(
                            &callback_buffer,
                            data.iter()
                                .map(|sample| super::audio::normalize_u16(*sample)),
                        )
                    },
                    |_error| {},
                    None,
                )
            }
            _ => return Err(VoiceErrorCode::DeviceUnavailable),
        }
        .map_err(|_| VoiceErrorCode::DeviceUnavailable)?;
        stream
            .play()
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)?;
        Ok(Box::new(CpalCaptureSession {
            stream: Some(stream),
            buffer,
            started_at: Instant::now(),
        }))
    }
}

#[cfg(windows)]
struct CpalCaptureSession {
    stream: Option<cpal::Stream>,
    buffer: Arc<Mutex<CaptureBuffer>>,
    started_at: Instant,
}

#[cfg(windows)]
impl AudioCaptureSession for CpalCaptureSession {
    fn stop(mut self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode> {
        self.stream.take();
        self.buffer
            .lock()
            .map(|buffer| buffer.audio())
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)
    }
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
    fn normalized_level(&self) -> f32 {
        self.buffer.lock().map(|buffer| buffer.level).unwrap_or(0.0)
    }
}

struct CaptureBuffer {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    max_samples: usize,
    level: f32,
}

impl CaptureBuffer {
    fn new(channels: u16, sample_rate: u32, max_duration_seconds: u32) -> Self {
        let max_seconds = (max_duration_seconds as u64).clamp(1, MAX_RECORDING_MS / 1000);
        Self {
            samples: Vec::with_capacity(
                (sample_rate as u64 * channels as u64 * max_seconds) as usize,
            ),
            channels,
            sample_rate,
            max_samples: (sample_rate as u64 * channels as u64 * max_seconds) as usize,
            level: 0.0,
        }
    }
    fn audio(&self) -> CapturedAudio {
        CapturedAudio {
            samples: self.samples.clone(),
            channels: self.channels,
            sample_rate: self.sample_rate,
        }
    }
}

fn push_samples<I: IntoIterator<Item = f32>>(buffer: &Arc<Mutex<CaptureBuffer>>, samples: I) {
    if let Ok(mut buffer) = buffer.try_lock() {
        let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
        let incoming: Vec<f32> = samples.into_iter().take(remaining).collect();
        buffer.level =
            incoming.iter().map(|sample| sample.abs()).sum::<f32>() / incoming.len().max(1) as f32;
        buffer.samples.extend(incoming);
    }
}

#[cfg(test)]
pub struct FakeCaptureSource {
    pub audio: CapturedAudio,
}

#[cfg(test)]
impl AudioCaptureSource for FakeCaptureSource {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode> {
        Ok(vec![VoiceInputDevice {
            id: "fake".into(),
            name: "Fake microphone".into(),
            is_default: true,
            available: true,
        }])
    }
    fn start(
        &self,
        _selected_device_id: Option<&str>,
        _max_duration_seconds: u32,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode> {
        Ok(Box::new(FakeCaptureSession {
            audio: self.audio.clone(),
            started_at: Instant::now(),
        }))
    }
}

#[cfg(test)]
struct FakeCaptureSession {
    audio: CapturedAudio,
    started_at: Instant,
}

#[cfg(test)]
impl AudioCaptureSession for FakeCaptureSession {
    fn stop(self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode> {
        Ok(self.audio.clone())
    }
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
    fn normalized_level(&self) -> f32 {
        0.5
    }
}
