use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
#[cfg(any(windows, test))]
use std::time::Instant;

use super::types::{
    CapturedAudio, VoiceCaptureOptions, VoiceErrorCode, VoiceInputDevice, MAX_RECORDING_MS,
};
use super::vad::{EnergyVad, EnergyVadConfig, VadState};

pub trait AudioCaptureSession: Send {
    fn stop(self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode>;
    fn elapsed_ms(&self) -> u64;
    fn normalized_level(&self) -> f32;
    fn failure(&self) -> Option<VoiceErrorCode> {
        None
    }
    fn vad_state(&self) -> VadState {
        VadState::Silence
    }
    fn speech_started(&self) -> bool {
        true
    }
    fn should_auto_stop(&self) -> bool {
        false
    }
}

pub trait AudioCaptureSource: Send + Sync {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode>;
    fn start(
        &self,
        selected_device_id: Option<&str>,
        options: VoiceCaptureOptions,
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
        _options: VoiceCaptureOptions,
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
        options: VoiceCaptureOptions,
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
            options,
        )));
        let callback_buffer = Arc::clone(&buffer);
        let config: cpal::StreamConfig = supported.clone().into();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| push_samples(&callback_buffer, data.iter().copied()),
                {
                    let error_buffer = Arc::clone(&buffer);
                    move |_error| record_failure(&error_buffer)
                },
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
                    {
                        let error_buffer = Arc::clone(&buffer);
                        move |_error| record_failure(&error_buffer)
                    },
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
                    {
                        let error_buffer = Arc::clone(&buffer);
                        move |_error| record_failure(&error_buffer)
                    },
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
            .map(|buffer| {
                if let Some(error) = buffer.failure {
                    Err(error)
                } else {
                    Ok(buffer.audio())
                }
            })
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)
            .and_then(|result| result)
    }
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
    fn normalized_level(&self) -> f32 {
        self.buffer.lock().map(|buffer| buffer.level).unwrap_or(0.0)
    }
    fn vad_state(&self) -> VadState {
        self.buffer
            .lock()
            .map(|buffer| buffer.vad_state())
            .unwrap_or(VadState::Silence)
    }
    fn speech_started(&self) -> bool {
        self.buffer
            .lock()
            .map(|buffer| buffer.speech_started())
            .unwrap_or(false)
    }
    fn should_auto_stop(&self) -> bool {
        self.buffer
            .lock()
            .map(|buffer| buffer.should_auto_stop())
            .unwrap_or(false)
    }
    fn failure(&self) -> Option<VoiceErrorCode> {
        self.buffer.lock().ok().and_then(|buffer| buffer.failure)
    }
}

struct CaptureBuffer {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    max_samples: usize,
    level: f32,
    pre_roll: VecDeque<f32>,
    max_pre_roll_samples: usize,
    vad: Option<EnergyVad>,
    failure: Option<VoiceErrorCode>,
}

impl CaptureBuffer {
    fn new(channels: u16, sample_rate: u32, options: VoiceCaptureOptions) -> Self {
        let options = options.bounded();
        let max_seconds = (options.max_duration_seconds as u64).clamp(1, MAX_RECORDING_MS / 1000);
        let max_pre_roll_samples =
            (sample_rate as u64 * channels as u64 * options.vad_pre_roll_ms as u64 / 1000) as usize;
        let vad = if options.activation_mode == crate::settings::store::VoiceActivationMode::Vad
            || options.vad_enabled
        {
            Some(EnergyVad::new(EnergyVadConfig {
                threshold: options.vad_speech_threshold,
                start_frames: options.vad_start_frames,
                silence_frames: options.vad_silence_frames,
                post_speech_ms: options.vad_post_speech_ms,
                sample_rate,
                channels,
            }))
        } else {
            None
        };
        Self {
            samples: Vec::with_capacity(
                (sample_rate as u64 * channels as u64 * max_seconds) as usize,
            ),
            channels,
            sample_rate,
            max_samples: (sample_rate as u64 * channels as u64 * max_seconds) as usize,
            level: 0.0,
            pre_roll: VecDeque::with_capacity(max_pre_roll_samples),
            max_pre_roll_samples,
            vad,
            failure: None,
        }
    }
    fn audio(&self) -> CapturedAudio {
        CapturedAudio {
            samples: self.samples.clone(),
            channels: self.channels,
            sample_rate: self.sample_rate,
        }
    }
    fn vad_state(&self) -> VadState {
        self.vad
            .as_ref()
            .map(EnergyVad::state)
            .unwrap_or(VadState::Speech)
    }
    fn speech_started(&self) -> bool {
        self.vad
            .as_ref()
            .map(EnergyVad::speech_started)
            .unwrap_or(true)
    }
    fn should_auto_stop(&self) -> bool {
        self.vad
            .as_ref()
            .map(EnergyVad::should_stop)
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn record_failure(buffer: &Arc<Mutex<CaptureBuffer>>) {
    if let Ok(mut buffer) = buffer.lock() {
        buffer.failure = Some(VoiceErrorCode::DeviceUnavailable);
    }
}

fn push_samples<I: IntoIterator<Item = f32>>(buffer: &Arc<Mutex<CaptureBuffer>>, samples: I) {
    if let Ok(mut buffer) = buffer.try_lock() {
        let incoming: Vec<f32> = samples.into_iter().collect();
        buffer.level =
            incoming.iter().map(|sample| sample.abs()).sum::<f32>() / incoming.len().max(1) as f32;
        let speech_started = if let Some(vad) = buffer.vad.as_mut() {
            vad.process(&incoming);
            vad.speech_started()
        } else {
            true
        };
        if buffer.vad.is_some() {
            if speech_started && buffer.samples.is_empty() {
                let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
                let preroll = buffer
                    .pre_roll
                    .drain(..)
                    .take(remaining)
                    .collect::<Vec<_>>();
                buffer.samples.extend(preroll);
            }
            if speech_started {
                let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
                buffer.samples.extend(incoming.into_iter().take(remaining));
            } else if buffer.max_pre_roll_samples > 0 {
                buffer.pre_roll.extend(incoming);
                while buffer.pre_roll.len() > buffer.max_pre_roll_samples {
                    buffer.pre_roll.pop_front();
                }
            }
        } else {
            let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
            buffer.samples.extend(incoming.into_iter().take(remaining));
        }
    }
}

#[cfg(test)]
pub struct FakeCaptureSource {
    pub audio: CapturedAudio,
}

#[cfg(test)]
pub struct FailingCaptureSource {
    pub error: VoiceErrorCode,
}

#[cfg(test)]
impl AudioCaptureSource for FailingCaptureSource {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode> {
        Ok(Vec::new())
    }
    fn start(
        &self,
        _selected_device_id: Option<&str>,
        _options: VoiceCaptureOptions,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode> {
        Ok(Box::new(FailingCaptureSession { error: self.error }))
    }
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
        _options: VoiceCaptureOptions,
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
struct FailingCaptureSession {
    error: VoiceErrorCode,
}

#[cfg(test)]
impl AudioCaptureSession for FailingCaptureSession {
    fn stop(self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode> {
        Err(self.error)
    }
    fn elapsed_ms(&self) -> u64 {
        0
    }
    fn normalized_level(&self) -> f32 {
        0.0
    }
    fn failure(&self) -> Option<VoiceErrorCode> {
        Some(self.error)
    }
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
