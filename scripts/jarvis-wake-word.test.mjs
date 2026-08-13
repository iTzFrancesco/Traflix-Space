import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const captureSource = source("../src-tauri/src/jarvis/voice/capture.rs");
const commandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");
const registrySource = source("../src-tauri/src/jarvis/voice/registry.rs");
const wakeSource = source("../src-tauri/src/jarvis/voice/wake.rs");
const typesSource = source("../src-tauri/src/jarvis/voice/types.rs");
const settingsSource = source("../src-tauri/src/settings/store.rs");
const frontendTypesSource = source("../src/lib/jarvis/types.ts");
const overlaySource = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const widgetSource = source("../src/components/jarvis/JarvisWidget.tsx");

test("WAKE_ONLY stays distinct from the privacy hard-off mute", () => {
  assert.match(settingsSource, /pub muted: bool/);
  assert.match(settingsSource, /pub wake_word_enabled: bool/);
  assert.match(settingsSource, /WakeWord/);
  assert.match(frontendTypesSource, /wakeWordEnabled: boolean/);
  assert.match(frontendTypesSource, /\| "wake_word"/);

  const muteGuard = commandsSource.indexOf("ensure_microphone_unmuted");
  const providerRefresh = commandsSource.indexOf("refresh_dotenv_environment");
  assert.ok(muteGuard >= 0 && providerRefresh > muteGuard);
  assert.match(commandsSource, /VoiceErrorCode::MicrophoneMuted/);
});

test("privacy hard-off reports off even when wake word is enabled", () => {
  const statusStart = commandsSource.indexOf("pub async fn jarvis_wake_word_status");
  const statusEnd = commandsSource.indexOf("pub async fn jarvis_voice_start", statusStart);
  const statusCommand = commandsSource.slice(statusStart, statusEnd);

  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  assert.match(statusCommand, /if configured\.jarvis\.muted/);
  assert.match(statusCommand, /wake::off_status\(&config\)/);
  assert.match(statusCommand, /wake::status\(configured\.jarvis\.wake_word_enabled, &config\)/);
  assert.ok(
    statusCommand.indexOf("wake::off_status") < statusCommand.indexOf("wake::status"),
    "mute must win over the configured wake-word flag",
  );
});

test("the detector seam is local-only and unavailable fallback is explicit", () => {
  assert.match(wakeSource, /pub trait WakeWordEngine/);
  assert.match(wakeSource, /fn process\(/);
  assert.match(wakeSource, /fn reset\(&mut self\)/);
  assert.match(wakeSource, /pub struct LocalVadFallbackWakeEngine/);
  assert.match(wakeSource, /Ok\(Box::new\(LocalVadFallbackWakeEngine::new\(config\)\)\)/);
  assert.match(commandsSource, /wake::create_engine\(&wake_config\)\.map_err\(to_error\)\?/);
  assert.doesNotMatch(wakeSource, /reqwest|ureq|TcpStream|File::create/);
});

test("standby audio goes to the detector before any transcript buffer append", () => {
  assert.match(captureSource, /run_cpal_capture\(selected_device_id, options, wake_engine/);
  assert.match(captureSource, /if let Some\(mut engine\) = buffer\.wake_engine\.take\(\)/);
  assert.match(
    captureSource,
    /engine\s*\.process\(\s*&incoming, buffer\.sample_rate, buffer\.channels\)/,
  );

  const detector = captureSource.indexOf("if let Some(mut engine) = buffer.wake_engine.take()");
  const append = captureSource.indexOf("buffer.samples.extend", detector);
  assert.ok(detector >= 0 && append > detector);

  assert.equal(
    (captureSource.match(/let stream = match supported\.sample_format\(\)/g) || []).length,
    1,
  );
  assert.equal((captureSource.match(/drop\(stream\)/g) || []).length, 1);
  assert.equal((captureSource.match(/device\.build_input_stream\(/g) || []).length, 3);
});

test("wake fallback arms VAD instead of a non-triggering unavailable engine", () => {
  assert.match(wakeSource, /state: WakeWordState::Fallback/);
  assert.match(wakeSource, /"vad-fallback"/);
  assert.match(overlaySource, /state !== "unavailable"/);
  assert.match(overlaySource, /const vadFallbackReady = !wakeWordReady/);
  assert.match(overlaySource, /store\.settings\.jarvis\.voiceInput\.activationMode === "vad"/);
  assert.match(overlaySource, /if \(liveWakeWordReady\)/);
  assert.match(overlaySource, /activationMode: "wake_word"/);
  assert.match(widgetSource, /Wake word · fallback VAD locale/);
});

test("wake status follows off → standby → listening transitions", () => {
  assert.match(frontendTypesSource, /"off" \| "standby" \| "listening" \| "fallback" \| "unavailable" \| "error"/);
  assert.match(typesSource, /WakeWordState::Standby|enum WakeWordState/);
  assert.match(commandsSource, /wake::standby_status\(true, &wake_config\)/);
  assert.match(commandsSource, /wake::listening_status\(true, &event_wake_config/);
  assert.match(commandsSource, /jarvis:\/\/wake-state/);
  assert.match(registrySource, /VoiceRequestStatus::Armed/);
  assert.match(registrySource, /speech_started \|\| wake_word_activated/);
});
