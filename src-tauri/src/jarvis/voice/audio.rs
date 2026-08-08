#[cfg(test)]
use std::io::Cursor;
use std::ops::Range;

use super::types::{
    CapturedAudio, VoiceErrorCode, MAX_WAV_BYTES, MIN_RECORDING_MS, TARGET_SAMPLE_RATE,
};

// Kept deliberately below the normal VAD threshold. This trim only removes
// edge silence from an already captured turn; it must not eat quiet speech.
const CLOUD_SILENCE_THRESHOLD: f32 = 0.003;
const CLOUD_SILENCE_PADDING_MS: u64 = 160;
const LEVEL_FLOOR_DB: f32 = -52.0;
const LEVEL_CEILING_DB: f32 = 0.0;

/// Converts a linear microphone block into a perceptual 0..1 level.
///
/// VAD keeps its own linear threshold; this value is only for the UI meter.
/// RMS shows sustained speech while a small peak contribution keeps consonants
/// and word onsets visible, matching the working Traflix-Voice pipeline.
pub fn perceptual_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let rms =
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt();
    let peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    let effective = rms.max(peak * 0.12).max(0.000001);
    let db = 20.0 * effective.log10();
    ((db - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB)).clamp(0.0, 1.0)
}

pub fn normalize_f32(sample: f32) -> f32 {
    sample.clamp(-1.0, 1.0)
}
pub fn normalize_i16(sample: i16) -> f32 {
    sample as f32 / 32768.0
}
pub fn normalize_u16(sample: u16) -> f32 {
    (sample as f32 - 32768.0) / 32768.0
}

pub fn mix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return samples.iter().copied().map(normalize_f32).collect();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().copied().map(normalize_f32).sum::<f32>() / frame.len() as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == target_rate {
        return input.to_vec();
    }
    let output_len = ((input.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * source_rate as f64 / target_rate as f64;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = position - left as f64;
            input[left] * (1.0 - fraction as f32) + input[right] * fraction as f32
        })
        .collect()
}

fn trim_silence_range(samples: &[f32], sample_rate: u32) -> Option<Range<usize>> {
    if samples.is_empty() {
        return None;
    }

    let threshold = CLOUD_SILENCE_THRESHOLD;
    let first = if samples[0].abs() >= threshold {
        0
    } else {
        samples
            .iter()
            .position(|sample| sample.abs() >= threshold)?
    };
    let last = if samples[samples.len() - 1].abs() >= threshold {
        samples.len() - 1
    } else {
        samples
            .iter()
            .rposition(|sample| sample.abs() >= threshold)?
    };

    let pad = (sample_rate as u64 * CLOUD_SILENCE_PADDING_MS / 1000) as usize;
    Some(first.saturating_sub(pad)..last.saturating_add(pad + 1).min(samples.len()))
}

#[cfg(test)]
pub fn trim_silence(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    trim_silence_range(samples, sample_rate)
        .map(|range| samples[range].to_vec())
        .unwrap_or_default()
}

pub fn encode_wav_pcm16(audio: &CapturedAudio) -> Result<Vec<u8>, VoiceErrorCode> {
    // CPAL already gives us normalized f32 samples. Avoid allocating a second
    // mono buffer for the overwhelmingly common one-channel capture path.
    let mono_storage;
    let mono: &[f32] = if audio.channels <= 1 {
        &audio.samples
    } else {
        mono_storage = mix_to_mono(&audio.samples, audio.channels);
        &mono_storage
    };

    // Likewise, do not clone a recording that is already at Whisper's target
    // rate. Only microphones that need conversion pay the resampling cost.
    let resampled_storage;
    let prepared: &[f32] = if audio.sample_rate == TARGET_SAMPLE_RATE {
        mono
    } else {
        resampled_storage = resample_linear(mono, audio.sample_rate, TARGET_SAMPLE_RATE);
        &resampled_storage
    };

    let range =
        trim_silence_range(prepared, TARGET_SAMPLE_RATE).ok_or(VoiceErrorCode::AudioTooShort)?;
    let trimmed = &prepared[range];
    let min_samples = (TARGET_SAMPLE_RATE as u64 * MIN_RECORDING_MS / 1000) as usize;
    if trimmed.len() < min_samples {
        return Err(VoiceErrorCode::AudioTooShort);
    }

    let data_len = trimmed
        .len()
        .checked_mul(2)
        .ok_or(VoiceErrorCode::AudioTooLarge)?;
    if 44_usize.saturating_add(data_len) > MAX_WAV_BYTES {
        return Err(VoiceErrorCode::AudioTooLarge);
    }
    let data_len_u32 = u32::try_from(data_len).map_err(|_| VoiceErrorCode::AudioTooLarge)?;

    // Write PCM straight into the final WAV allocation. The previous path
    // built an intermediate Vec<u8> and copied it into the WAV afterwards.
    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + data_len_u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len_u32.to_le_bytes());
    for sample in trimmed {
        let pcm = (normalize_f32(*sample) * 32767.0) as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    Ok(wav)
}

pub fn wav_duration_ms(wav: &[u8]) -> Option<u64> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" {
        return None;
    }
    let rate = u32::from_le_bytes(wav[24..28].try_into().ok()?);
    let data_len = u32::from_le_bytes(wav[40..44].try_into().ok()?) as u64;
    Some(data_len.saturating_mul(1000) / rate.max(1) as u64 / 2)
}

#[cfg(test)]
pub fn validate_wav(wav: &[u8]) -> bool {
    Cursor::new(wav).get_ref().len() >= 44 && &wav[0..4] == b"RIFF" && &wav[8..12] == b"WAVE"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jarvis::voice::types::TARGET_SAMPLE_RATE;

    #[test]
    fn sample_formats_are_normalized() {
        assert_eq!(normalize_f32(2.0), 1.0);
        assert_eq!(normalize_i16(-32768), -1.0);
        assert!((normalize_u16(65535) - 0.9999695).abs() < 0.0001);
    }

    #[test]
    fn perceptual_level_exposes_quiet_speech_and_rejects_silence() {
        assert_eq!(perceptual_level(&[]), 0.0);
        assert_eq!(perceptual_level(&[0.0; 128]), 0.0);
        let quiet = perceptual_level(&[0.01; 128]);
        let loud = perceptual_level(&[0.25; 128]);
        assert!(quiet > 0.0);
        assert!(loud > quiet);
    }

    #[test]
    fn stereo_is_mixed_and_resampled() {
        let mono = mix_to_mono(&[1.0, -1.0, 0.5, 0.5], 2);
        assert_eq!(mono, vec![0.0, 0.5]);
        let out = resample_linear(&mono, 8_000, TARGET_SAMPLE_RATE);
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn silence_is_trimmed_with_padding() {
        let mut samples = vec![0.0; 16_000];
        samples[8_000..8_100].fill(0.5);
        let trimmed = trim_silence(&samples, 16_000);
        assert!(trimmed.len() < samples.len());
        assert!(trimmed.len() >= 100);
    }

    #[test]
    fn fully_silent_audio_is_short_circuited() {
        assert!(trim_silence(&vec![0.0; 16_000], 16_000).is_empty());
    }

    #[test]
    fn quiet_speech_survives_cloud_edge_trim() {
        let mut samples = vec![0.0; 16_000];
        samples[8_000..8_100].fill(0.004);
        let trimmed = trim_silence(&samples, 16_000);
        assert!(trimmed.iter().any(|sample| sample.abs() >= 0.004));
    }

    #[test]
    fn wav_is_mono_pcm16_and_bounded() {
        let audio = CapturedAudio {
            samples: vec![0.3; 8_000],
            channels: 1,
            sample_rate: 16_000,
        };
        let wav = encode_wav_pcm16(&audio).unwrap();
        assert!(validate_wav(&wav));
        assert_eq!(&wav[22..24], &1_u16.to_le_bytes());
        assert_eq!(&wav[34..36], &16_u16.to_le_bytes());
        assert_eq!(wav_duration_ms(&wav), Some(500));
    }

    #[test]
    fn silent_audio_never_becomes_a_cloud_payload() {
        let audio = CapturedAudio {
            samples: vec![0.0; 8_000],
            channels: 1,
            sample_rate: 16_000,
        };
        assert_eq!(encode_wav_pcm16(&audio), Err(VoiceErrorCode::AudioTooShort));
    }

    #[test]
    fn short_audio_is_rejected() {
        let audio = CapturedAudio {
            samples: vec![0.2; 100],
            channels: 1,
            sample_rate: 16_000,
        };
        assert_eq!(encode_wav_pcm16(&audio), Err(VoiceErrorCode::AudioTooShort));
    }
}
