use std::collections::VecDeque;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::thread::{self, JoinHandle};
#[cfg(any(windows, test))]
use std::time::Instant;

use super::types::{
    CapturedAudio, VoiceCaptureOptions, VoiceEndpointState, VoiceErrorCode, VoiceInputDevice,
    MAX_RECORDING_MS,
};
use super::vad::{EnergyVad, EnergyVadConfig, VadState};
use super::wake::WakeWordEngine;

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
    fn endpoint_state(&self) -> VoiceEndpointState {
        if !self.speech_started() {
            VoiceEndpointState::Standby
        } else if self.vad_state() == VadState::Speech {
            VoiceEndpointState::Speaking
        } else if self.should_auto_stop() {
            VoiceEndpointState::Finalizing
        } else {
            VoiceEndpointState::Pause
        }
    }
    fn wake_word_activated(&self) -> bool {
        false
    }
}

pub trait AudioCaptureSource: Send + Sync {
    fn list_input_devices(&self) -> Result<Vec<VoiceInputDevice>, VoiceErrorCode>;
    fn start(
        &self,
        selected_device_id: Option<&str>,
        options: VoiceCaptureOptions,
        _wake_engine: Option<Box<dyn WakeWordEngine>>,
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
        _wake_engine: Option<Box<dyn WakeWordEngine>>,
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
        wake_engine: Option<Box<dyn WakeWordEngine>>,
    ) -> Result<Box<dyn AudioCaptureSession>, VoiceErrorCode> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (stop_tx, stop_rx) = mpsc::channel();
        let selected_device_id = selected_device_id.map(ToOwned::to_owned);
        let capture_thread = thread::Builder::new()
            .name("traflix-audio-capture".into())
            .spawn(move || {
                run_cpal_capture(selected_device_id, options, wake_engine, ready_tx, stop_rx);
            })
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)?;
        let buffer = match ready_rx
            .recv()
            .map_err(|_| VoiceErrorCode::DeviceUnavailable)?
        {
            Ok(buffer) => buffer,
            Err(error) => {
                let _ = capture_thread.join();
                return Err(error);
            }
        };
        Ok(Box::new(CpalCaptureSession {
            stop_tx: Some(stop_tx),
            capture_thread: Some(capture_thread),
            buffer,
            started_at: Instant::now(),
        }))
    }
}

#[cfg(windows)]
fn run_cpal_capture(
    selected_device_id: Option<String>,
    options: VoiceCaptureOptions,
    wake_engine: Option<Box<dyn WakeWordEngine>>,
    ready_tx: SyncSender<Result<Arc<Mutex<CaptureBuffer>>, VoiceErrorCode>>,
    stop_rx: Receiver<()>,
) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let setup = (|| {
        let host = cpal::default_host();
        let device = if let Some(selected) = selected_device_id.as_deref() {
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
            wake_engine,
        )));
        let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<f32>>(32);
        let callback_failed = Arc::new(AtomicBool::new(false));
        let callback_sender = sample_tx.clone();
        let callback_failed_for_samples = Arc::clone(&callback_failed);
        let config: cpal::StreamConfig = supported.clone().into();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    push_samples(
                        &callback_sender,
                        data.iter().copied(),
                        &callback_failed_for_samples,
                    )
                },
                {
                    let error_flag = Arc::clone(&callback_failed);
                    move |_error| record_failure(&error_flag)
                },
                None,
            ),
            cpal::SampleFormat::I16 => {
                let callback_sender = sample_tx.clone();
                let callback_failed_for_samples = Arc::clone(&callback_failed);
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        push_samples(
                            &callback_sender,
                            data.iter()
                                .map(|sample| super::audio::normalize_i16(*sample)),
                            &callback_failed_for_samples,
                        )
                    },
                    {
                        let error_flag = Arc::clone(&callback_failed);
                        move |_error| record_failure(&error_flag)
                    },
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let callback_sender = sample_tx.clone();
                let callback_failed_for_samples = Arc::clone(&callback_failed);
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        push_samples(
                            &callback_sender,
                            data.iter()
                                .map(|sample| super::audio::normalize_u16(*sample)),
                            &callback_failed_for_samples,
                        )
                    },
                    {
                        let error_flag = Arc::clone(&callback_failed);
                        move |_error| record_failure(&error_flag)
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
        Ok((stream, buffer, sample_rx, callback_failed))
    })();

    let (stream, buffer, sample_rx, callback_failed) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    if ready_tx.send(Ok(buffer.clone())).is_err() {
        return;
    }
    let mut stopping = false;
    loop {
        if !stopping && stop_rx.try_recv().is_ok() {
            stopping = true;
        }
        if stopping {
            // Drain buffers accepted before stop so the last syllable is not
            // lost between the CPAL callback and the capture worker.
            match sample_rx.try_recv() {
                Ok(samples) => process_samples(&buffer, samples),
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
            }
        } else {
            match sample_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                Ok(samples) => process_samples(&buffer, samples),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    if callback_failed.load(Ordering::Acquire) {
        if let Ok(mut buffer) = buffer.lock() {
            buffer.failure = Some(VoiceErrorCode::DeviceUnavailable);
        }
    }
    drop(stream);
}

#[cfg(windows)]
struct CpalCaptureSession {
    stop_tx: Option<Sender<()>>,
    capture_thread: Option<JoinHandle<()>>,
    buffer: Arc<Mutex<CaptureBuffer>>,
    started_at: Instant,
}

#[cfg(windows)]
impl AudioCaptureSession for CpalCaptureSession {
    fn stop(mut self: Box<Self>) -> Result<CapturedAudio, VoiceErrorCode> {
        self.stop_stream();
        self.buffer
            .lock()
            .map(|mut buffer| {
                if let Some(error) = buffer.failure {
                    Err(error)
                } else {
                    // The CPAL stream and callback have already been joined.
                    // Move the recording out instead of cloning every sample
                    // on the latency-critical stop path.
                    Ok(buffer.take_audio())
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
    fn endpoint_state(&self) -> VoiceEndpointState {
        self.buffer
            .lock()
            .map(|buffer| buffer.endpoint_state())
            .unwrap_or(VoiceEndpointState::Standby)
    }
    fn failure(&self) -> Option<VoiceErrorCode> {
        self.buffer.lock().ok().and_then(|buffer| buffer.failure)
    }
    fn wake_word_activated(&self) -> bool {
        self.buffer
            .lock()
            .map(|buffer| buffer.wake_word_activated)
            .unwrap_or(false)
    }
}

#[cfg(windows)]
impl CpalCaptureSession {
    fn stop_stream(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(capture_thread) = self.capture_thread.take() {
            let _ = capture_thread.join();
        }
    }
}

#[cfg(windows)]
impl Drop for CpalCaptureSession {
    fn drop(&mut self) {
        self.stop_stream();
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
    wake_engine: Option<Box<dyn WakeWordEngine>>,
    wake_word_activated: bool,
    failure: Option<VoiceErrorCode>,
}

impl CaptureBuffer {
    fn new(
        channels: u16,
        sample_rate: u32,
        options: VoiceCaptureOptions,
        wake_engine: Option<Box<dyn WakeWordEngine>>,
    ) -> Self {
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
            wake_engine,
            wake_word_activated: false,
            failure: None,
        }
    }
    fn take_audio(&mut self) -> CapturedAudio {
        CapturedAudio {
            samples: std::mem::take(&mut self.samples),
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
    fn endpoint_state(&self) -> VoiceEndpointState {
        if self.vad.is_none() {
            return VoiceEndpointState::Speaking;
        }
        if !self.speech_started() {
            return VoiceEndpointState::Standby;
        }
        if self.should_auto_stop() {
            return VoiceEndpointState::Finalizing;
        }
        match self.vad_state() {
            VadState::Speech => VoiceEndpointState::Speaking,
            VadState::MaybeSpeech => VoiceEndpointState::MicroInterruption,
            VadState::Silence if self.vad.as_ref().is_some_and(EnergyVad::pause_is_breath) => {
                VoiceEndpointState::Breath
            }
            VadState::Silence => VoiceEndpointState::Pause,
        }
    }
}

#[cfg(windows)]
fn record_failure(failed: &Arc<AtomicBool>) {
    failed.store(true, Ordering::Release);
}

#[cfg(windows)]
fn push_samples<I: IntoIterator<Item = f32>>(
    sender: &SyncSender<Vec<f32>>,
    samples: I,
    failed: &Arc<AtomicBool>,
) {
    let incoming: Vec<f32> = samples.into_iter().collect();
    if incoming.is_empty() {
        return;
    }
    if let Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) =
        sender.try_send(incoming)
    {
        // Never block the realtime callback. A full queue is still a hard
        // capture failure rather than silently corrupting the transcript.
        failed.store(true, Ordering::Release);
    }
}

#[cfg(windows)]
fn process_samples(buffer: &Arc<Mutex<CaptureBuffer>>, incoming: Vec<f32>) {
    if let Ok(mut buffer) = buffer.lock() {
        let target_level = super::audio::perceptual_level(&incoming);
        buffer.level = super::audio::smooth_perceptual_level(buffer.level, target_level);

        // Wake-only capture shares this CPAL stream with the later recording
        // phase. Until the engine confirms a keyword, no raw samples are kept
        // in the transcript buffer and no VAD recording is started.
        let mut wake_detected = false;
        if let Some(mut engine) = buffer.wake_engine.take() {
            let detected = engine
                .process(&incoming, buffer.sample_rate, buffer.channels)
                .is_some();
            if detected {
                engine.reset();
                buffer.wake_word_activated = true;
                wake_detected = true;
            } else {
                buffer.wake_engine = Some(engine);
                return;
            }
        }

        let (speech_started, gate_threshold) = if let Some(vad) = buffer.vad.as_mut() {
            vad.process(&incoming);
            (vad.speech_started(), Some(vad.noise_gate_threshold()))
        } else {
            (true, None)
        };
        if buffer.vad.is_some() {
            if speech_started && buffer.samples.is_empty() {
                let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
                let preroll: Vec<f32> = std::mem::take(&mut buffer.pre_roll).into_iter().collect();
                // Pre-roll is the only evidence captured before VAD confirms
                // speech. Preserve it verbatim so a quiet first syllable is
                // not attenuated away by a floor learned from the room.
                buffer.samples.extend(preroll.into_iter().take(remaining));
            }
            if speech_started || wake_detected {
                let remaining = buffer.max_samples.saturating_sub(buffer.samples.len());
                // The detector's activation frame is the first retained
                // evidence of the utterance. Do not attenuate it with the
                // post-VAD room gate or a quiet "Jarvis" onset can disappear
                // before STT sees it.
                let retained = if wake_detected {
                    incoming
                } else {
                    gate_threshold
                        .map(|threshold| super::audio::apply_noise_gate(&incoming, threshold))
                        .unwrap_or(incoming)
                };
                buffer.samples.extend(retained.into_iter().take(remaining));
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
        _wake_engine: Option<Box<dyn WakeWordEngine>>,
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
        _wake_engine: Option<Box<dyn WakeWordEngine>>,
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::jarvis::voice::wake::{WakeWordDetection, WakeWordEngine};
    use crate::settings::store::VoiceActivationMode;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TriggerOnFirstFrame {
        triggered: bool,
    }

    impl WakeWordEngine for TriggerOnFirstFrame {
        fn backend_name(&self) -> &'static str {
            "test"
        }

        fn process(
            &mut self,
            _samples: &[f32],
            _sample_rate: u32,
            _channels: u16,
        ) -> Option<WakeWordDetection> {
            if self.triggered {
                None
            } else {
                self.triggered = true;
                Some(WakeWordDetection { score: 0.9 })
            }
        }

        fn reset(&mut self) {}
    }

    fn wake_options() -> VoiceCaptureOptions {
        VoiceCaptureOptions {
            activation_mode: VoiceActivationMode::WakeWord,
            max_duration_seconds: 45,
            max_armed_seconds: 120,
            vad_enabled: false,
            vad_speech_threshold: 0.018,
            vad_start_frames: 3,
            vad_silence_frames: 16,
            vad_pre_roll_ms: 250,
            vad_post_speech_ms: 650,
        }
    }

    fn vad_options() -> VoiceCaptureOptions {
        VoiceCaptureOptions {
            activation_mode: VoiceActivationMode::Vad,
            max_duration_seconds: 45,
            max_armed_seconds: 120,
            vad_enabled: true,
            vad_speech_threshold: 0.018,
            vad_start_frames: 3,
            vad_silence_frames: 16,
            vad_pre_roll_ms: 500,
            vad_post_speech_ms: 650,
        }
    }

    #[test]
    fn wake_only_keeps_no_pre_match_audio_and_keeps_the_activation_frame() {
        let buffer = Arc::new(Mutex::new(CaptureBuffer::new(
            1,
            16_000,
            wake_options(),
            Some(Box::new(TriggerOnFirstFrame { triggered: false })),
        )));

        process_samples(&buffer, vec![0.4; 160]);
        let snapshot = buffer.lock().unwrap();
        assert!(snapshot.wake_word_activated);
        assert_eq!(snapshot.samples.len(), 160);
        drop(snapshot);

        process_samples(&buffer, vec![0.4; 160]);
        assert_eq!(buffer.lock().unwrap().samples.len(), 320);
    }

    struct CountingWakeEngine {
        calls: Arc<AtomicUsize>,
        trigger_on_call: usize,
    }

    impl WakeWordEngine for CountingWakeEngine {
        fn backend_name(&self) -> &'static str {
            "test-local"
        }

        fn process(
            &mut self,
            _samples: &[f32],
            _sample_rate: u32,
            _channels: u16,
        ) -> Option<WakeWordDetection> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            (call >= self.trigger_on_call).then_some(WakeWordDetection { score: 0.93 })
        }

        fn reset(&mut self) {}
    }

    #[test]
    fn wake_only_discards_standby_frames_but_keeps_the_detector_match() {
        let calls = Arc::new(AtomicUsize::new(0));
        let buffer = Arc::new(Mutex::new(CaptureBuffer::new(
            1,
            16_000,
            wake_options(),
            Some(Box::new(CountingWakeEngine {
                calls: Arc::clone(&calls),
                trigger_on_call: 3,
            })),
        )));

        process_samples(&buffer, vec![0.1; 160]);
        process_samples(&buffer, vec![0.2; 160]);
        {
            let snapshot = buffer.lock().unwrap();
            assert!(!snapshot.wake_word_activated);
            assert!(snapshot.samples.is_empty());
            assert!(snapshot.pre_roll.is_empty());
        }

        process_samples(&buffer, vec![0.9; 160]);
        {
            let snapshot = buffer.lock().unwrap();
            assert!(snapshot.wake_word_activated);
            assert_eq!(snapshot.samples.len(), 160);
        }

        process_samples(&buffer, vec![0.8; 160]);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(buffer.lock().unwrap().samples.len(), 320);
    }

    #[test]
    fn vad_pre_roll_keeps_audio_before_calibrated_speech_start() {
        let buffer = Arc::new(Mutex::new(CaptureBuffer::new(
            1,
            16_000,
            vad_options(),
            None,
        )));

        process_samples(&buffer, vec![0.002; 160]);
        process_samples(&buffer, vec![0.10; 160]);
        process_samples(&buffer, vec![0.10; 160]);
        process_samples(&buffer, vec![0.10; 160]);
        process_samples(&buffer, vec![0.10; 160]);

        let snapshot = buffer.lock().unwrap();
        assert!(snapshot.speech_started());
        assert_eq!(snapshot.samples.first().copied(), Some(0.002));
        assert!(snapshot.samples.len() >= 4 * 160);
    }
}
