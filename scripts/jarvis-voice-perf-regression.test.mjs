import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const audioSource = source("../src-tauri/src/jarvis/voice/audio.rs");
const captureSource = source("../src-tauri/src/jarvis/voice/capture.rs");
const sttSource = source("../src-tauri/src/jarvis/voice/stt.rs");
const ttsSource = source("../src-tauri/src/jarvis/voice/tts.rs");
const playbackSource = source("../src-tauri/src/jarvis/voice/playback.rs");
const helperSource = source("./jarvis-edge-tts.py");
const mainSource = source("../src-tauri/src/main.rs");

test("STT audio preparation keeps mono/16k zero-copy fast paths", () => {
  assert.match(audioSource, /if audio\.channels <= 1/);
  assert.match(audioSource, /if audio\.sample_rate == TARGET_SAMPLE_RATE/);
  assert.match(audioSource, /trim_silence_range/);
  assert.match(audioSource, /CLOUD_SILENCE_THRESHOLD: f32 = 0\.003/);
  assert.match(audioSource, /ok_or\(VoiceErrorCode::AudioTooShort\)/);
  assert.match(audioSource, /Vec::with_capacity\(44 \+ data_len\)/);
  assert.doesNotMatch(audioSource, /flat_map\(\|sample\|/);
});

test("capture stop moves the recording instead of cloning it", () => {
  assert.match(captureSource, /std::mem::take\(&mut self\.samples\)/);
  assert.match(captureSource, /Ok\(buffer\.take_audio\(\)\)/);
  assert.doesNotMatch(captureSource, /fn audio\(&self\)[\s\S]*self\.samples\.clone\(\)/);
});

test("Groq STT reuses transport and avoids generic multipart/JSON success parsing", () => {
  assert.match(sttSource, /static RUNTIME_PROVIDER: OnceLock/);
  assert.match(sttSource, /pool_idle_timeout/);
  assert.match(sttSource, /pool_max_idle_per_host\(1\)/);
  assert.match(sttSource, /tcp_nodelay\(true\)/);
  assert.match(sttSource, /build_groq_multipart/);
  assert.match(sttSource, /response_format", "text"/);
  assert.match(sttSource, /std::str::from_utf8\(&body\)/);
  assert.doesNotMatch(sttSource, /reqwest::\{multipart/);
  assert.doesNotMatch(sttSource, /serde_json::from_slice/);
});

test("Edge TTS helper stays alive and caches the imported module", () => {
  assert.match(helperSource, /_EDGE_TTS/);
  assert.match(helperSource, /action == "ping"/);
  assert.match(helperSource, /for raw_line in sys\.stdin/);
  assert.match(helperSource, /action == "quit"/);
});

test("Rust TTS shares one warm worker and prewarms it at startup", () => {
  assert.match(ttsSource, /static WORKER: OnceLock<SharedWorker>/);
  assert.match(ttsSource, /pub fn prewarm_runtime/);
  assert.match(ttsSource, /pub async fn shutdown_runtime/);
  assert.match(ttsSource, /mpsc::channel::<HelperRequest>/);
  assert.match(mainSource, /jarvis::voice::tts::prewarm_runtime\(app\.handle\(\)\.clone\(\)\)/);
  assert.match(mainSource, /jarvis::voice::tts::shutdown_runtime\(\)\.await/);
});

test("Windows playback keeps the output stream warm between replies", () => {
  assert.match(playbackSource, /static WORKER: OnceLock<mpsc::Sender<PlaybackRequest>>/);
  assert.match(playbackSource, /fn playback_loop/);
  assert.match(playbackSource, /OutputStream::try_default\(\)/);
  assert.match(playbackSource, /while let Ok\(request\) = receiver\.recv\(\)/);
  assert.match(playbackSource, /Duration::from_millis\(8\)/);
});
