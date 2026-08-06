use std::io::Cursor;

use super::types::{
    CapturedAudio, VoiceErrorCode, MAX_WAV_BYTES, MIN_RECORDING_MS, TARGET_SAMPLE_RATE,
};

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

pub fn trim_silence(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let window = ((sample_rate as usize * 30) / 1000).max(1);
    let hop = (window / 2).max(1);
    let threshold = 0.02_f32;
    let mut first = None;
    let mut last = None;
    let mut start = 0;
    while start + window <= samples.len() {
        let rms = (samples[start..start + window]
            .iter()
            .map(|sample| sample * sample)
            .sum::<f32>()
            / window as f32)
            .sqrt();
        if rms > threshold {
            first.get_or_insert(start);
            last = Some(start + window);
        }
        start += hop;
    }
    match (first, last) {
        (Some(first), Some(last)) => {
            let pad = sample_rate as usize * 300 / 1000;
            samples[first.saturating_sub(pad)..last.saturating_add(pad).min(samples.len())].to_vec()
        }
        _ => samples.to_vec(),
    }
}

pub fn encode_wav_pcm16(audio: &CapturedAudio) -> Result<Vec<u8>, VoiceErrorCode> {
    let mono = mix_to_mono(&audio.samples, audio.channels);
    let resampled = resample_linear(&mono, audio.sample_rate, TARGET_SAMPLE_RATE);
    let trimmed = trim_silence(&resampled, TARGET_SAMPLE_RATE);
    let min_samples = (TARGET_SAMPLE_RATE as u64 * MIN_RECORDING_MS / 1000) as usize;
    if trimmed.len() < min_samples {
        return Err(VoiceErrorCode::AudioTooShort);
    }
    let data: Vec<u8> = trimmed
        .iter()
        .flat_map(|sample| ((normalize_f32(*sample) * 32767.0).round() as i16).to_le_bytes())
        .collect();
    let mut wav = Vec::with_capacity(44 + data.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&data);
    if wav.len() > MAX_WAV_BYTES {
        return Err(VoiceErrorCode::AudioTooLarge);
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
    fn short_audio_is_rejected() {
        let audio = CapturedAudio {
            samples: vec![0.2; 100],
            channels: 1,
            sample_rate: 16_000,
        };
        assert_eq!(encode_wav_pcm16(&audio), Err(VoiceErrorCode::AudioTooShort));
    }
}
