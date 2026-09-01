import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const audioSource = source("../src-tauri/src/jarvis/voice/audio.rs");
const captureSource = source("../src-tauri/src/jarvis/voice/capture.rs");
const sttSource = source("../src-tauri/src/jarvis/voice/stt.rs");
const ttsSource = source("../src-tauri/src/jarvis/voice/tts.rs");
const ttsWorkerSource = source("../src-tauri/src/jarvis/voice/tts_worker.rs");
const playbackSource = source("../src-tauri/src/jarvis/voice/playback.rs");
const helperSource = source("./jarvis-edge-tts.py");
const mainSource = source("../src-tauri/src/main.rs");
const beforeBuildSource = source("./tauri-before-build.ps1");
const sidecarBuildSource = source("./build-jarvis-edge-tts-sidecar.ps1");
const gitignoreSource = source("../.gitignore");
const secretsSource = source("../src-tauri/src/settings/secrets.rs");
const runtimeDetectorSource = source("../src-tauri/src/jarvis/runtime_detector.rs");

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
  assert.doesNotMatch(sttSource, /build\(\)\s*\.expect\("voice HTTP client"\)/);
});

test("Edge TTS helper stays alive and caches the imported module", () => {
  assert.match(helperSource, /_EDGE_TTS/);
  assert.match(helperSource, /action == "ping"/);
  assert.match(helperSource, /for raw_line in sys\.stdin/);
  assert.match(helperSource, /action == "quit"/);
});

test("Windows backend subprocesses stay hidden and the TTS sidecar has no console", () => {
  assert.match(secretsSource, /creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(runtimeDetectorSource, /creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(sidecarBuildSource, /--windowed/);
  assert.equal(existsSync(new URL("../public/icon.png", import.meta.url)), true);
});

test("heavy-runtime failures cannot overlap process scans or panic through closed stdio", () => {
  assert.match(runtimeDetectorSource, /process_tree_scan_gate/);
  assert.match(runtimeDetectorSource, /process-tree-query-busy/);
  assert.match(runtimeDetectorSource, /let _permit = permit/);
  assert.match(mainSource, /persistent tracing sink is the only panic path allowed here/);
  assert.doesNotMatch(mainSource, /default_hook\(panic_info\)/);
});

test("Rust TTS shares one warm worker and prewarms it at startup", () => {
  assert.match(ttsSource, /static WORKER: OnceLock<SharedWorker>/);
  assert.match(ttsSource, /pub fn prewarm_runtime/);
  assert.match(ttsSource, /pub async fn shutdown_runtime/);
  assert.match(ttsWorkerSource, /mpsc::channel::<HelperRequest>/);
  assert.match(mainSource, /jarvis::voice::tts::prewarm_runtime\(app\.handle\(\)\.clone\(\)\)/);
  assert.match(mainSource, /jarvis::voice::tts::shutdown_runtime\(\)\.await/);
});

test("Windows playback keeps healthy output warm and can replace failed workers or devices", () => {
  assert.match(playbackSource, /static WORKER: OnceLock<Mutex<Option<std::sync::mpsc::Sender<PlaybackRequest>>>>/);
  assert.match(playbackSource, /fn playback_loop/);
  assert.match(playbackSource, /ensure_cached\(output, OutputStream::try_default\)/);
  assert.match(playbackSource, /output\.take\(\)/);
  assert.match(playbackSource, /reset_playback_sender/);
  assert.match(playbackSource, /PlaybackDeviceUnavailable/);
  assert.match(playbackSource, /while let Ok\(request\) = receiver\.recv\(\)/);
  assert.match(playbackSource, /Duration::from_millis\(8\)/);
});

test("Windows config merge retains MSI settings and regenerates the x86_64 TTS sidecar", () => {
  const base = JSON.parse(source("../src-tauri/tauri.conf.json"));
  const windows = JSON.parse(source("../src-tauri/tauri.windows.conf.json"));
  const merged = {
    ...base,
    build: { ...base.build, ...windows.build },
    bundle: { ...base.bundle, ...windows.bundle },
  };
  assert.equal(
    merged.build.beforeBuildCommand,
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tauri-before-build.ps1",
  );
  assert.equal(merged.build.frontendDist, "../dist");
  assert.deepEqual(merged.bundle.targets, ["msi"]);
  assert.equal(merged.bundle.useLocalToolsDir, true);
  assert.deepEqual(merged.bundle.externalBin, ["binaries/jarvis-edge-tts"]);
  assert.ok(merged.bundle.resources["../scripts/agent-notifications/*"]);

  assert.match(sidecarBuildSource, /New-Item -ItemType Directory -Force -Path \$binaries/);
  assert.match(sidecarBuildSource, /PyInstaller/);
  assert.match(sidecarBuildSource, /Copy-Item[\s\S]*\$TargetTriple/);
  assert.match(gitignoreSource, /src-tauri\/binaries\//);
  assert.match(beforeBuildSource, /& \$sidecarScript -Python \$python/);
  assert.match(beforeBuildSource, /embedded helper always matches/);
  assert.match(beforeBuildSource, /ReadAllBytes\(\$sidecar\)/);
  assert.match(beforeBuildSource, /machine -ne 0x8664/);
  assert.match(beforeBuildSource, /Verified Jarvis Edge TTS x86_64 sidecar/);
});
