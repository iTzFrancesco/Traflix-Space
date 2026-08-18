import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  defaultJarvisSettings,
  isJarvisOwnerModeReady,
  ownerModeJarvisSettings,
} from "../src/lib/jarvis/settings.ts";
import {
  decideVoiceSubmit,
  manualVoiceToggle,
} from "../src/lib/jarvis/voiceState.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const overlaySource = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const widgetSource = source("../src/components/jarvis/JarvisWidget.tsx");
const voiceCommandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");

test("Jarvis defaults to an explicit click-toggle voice turn", () => {
  const settings = defaultJarvisSettings();
  assert.equal(settings.voiceInput.activationMode, "click_toggle");
  assert.equal(settings.voiceInput.autoSubmitTranscript, false);
  assert.equal(settings.voiceInput.vadEnabled, false);
  assert.equal(settings.voiceInput.endpointingEnabled, false);
  assert.equal(settings.voiceOutput.stopOnUserSpeech, false);
  assert.equal(isJarvisOwnerModeReady(settings), true);
});

test("legacy voice settings migrate to the safe manual policy", () => {
  const legacy = defaultJarvisSettings();
  legacy.voiceInput.activationMode = "vad";
  legacy.voiceInput.autoSubmitTranscript = true;
  legacy.voiceInput.vadEnabled = true;
  legacy.voiceInput.endpointingEnabled = true;
  legacy.wakeWordEnabled = true;
  legacy.voiceOutput.stopOnUserSpeech = true;

  const migrated = ownerModeJarvisSettings(legacy);
  assert.equal(migrated.voiceInput.activationMode, "click_toggle");
  assert.equal(migrated.voiceInput.autoSubmitTranscript, false);
  assert.equal(migrated.voiceInput.vadEnabled, false);
  assert.equal(migrated.voiceInput.endpointingEnabled, false);
  assert.equal(migrated.wakeWordEnabled, false);
  assert.equal(migrated.voiceOutput.stopOnUserSpeech, false);
});

test("the two manual toggle edges are start/listen then stop/process", () => {
  assert.deepEqual(manualVoiceToggle("idle"), "start");
  assert.deepEqual(manualVoiceToggle("recording"), "stop");
  assert.deepEqual(manualVoiceToggle("armed"), "stop");
  assert.deepEqual(manualVoiceToggle("transcribing"), "noop");
  assert.equal(decideVoiceSubmit({
    status: "transcript_ready",
    hasTranscript: true,
    autoSubmit: false,
    chatBusy: false,
    alreadyClaimed: false,
  }), "manual");
});

test("the UI and backend expose no automatic capture or TTS barge-in path", () => {
  assert.doesNotMatch(overlaySource, /AUTO_ARM_DELAY_MS|startBargeIn|bargeIn/);
  assert.doesNotMatch(overlaySource, /autoSubmitTranscript/);
  assert.match(widgetSource, /onVoiceToggle/);
  assert.match(widgetSource, /Avvia ascolto|Termina ascolto/);
  assert.match(voiceCommandsSource, /VoiceActivationMode::ClickToggle/);
  assert.match(voiceCommandsSource, /watchdog_config\.endpointing_enabled\s*=\s*automatic_capture/);
  assert.doesNotMatch(voiceCommandsSource, /stop_tts_on_speech/);
});
