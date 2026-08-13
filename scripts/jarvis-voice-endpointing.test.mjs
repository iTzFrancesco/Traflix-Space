import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideVoiceSubmit,
  shouldShowVoiceSendControl,
} from "../src/lib/jarvis/voiceState.ts";

const storeSource = readFileSync(new URL("../src/stores/jarvisStore.ts", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/components/jarvis/JarvisGlobalOverlay.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../src/components/jarvis/JarvisWidget.tsx", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/commands.rs", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src-tauri/src/settings/store.rs", import.meta.url), "utf8");
const vadSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/vad.rs", import.meta.url), "utf8");
const captureSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/capture.rs", import.meta.url), "utf8");
const voiceTypesSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/types.rs", import.meta.url), "utf8");
const frontendSettingsSource = readFileSync(new URL("../src/lib/jarvis/settings.ts", import.meta.url), "utf8");
const ttsSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/tts.rs", import.meta.url), "utf8");

test("submit policy queues a complete transcript while chat is busy", () => {
  assert.equal(decideVoiceSubmit({
    status: "transcript_ready",
    hasTranscript: true,
    autoSubmit: true,
    chatBusy: true,
    alreadyClaimed: false,
  }), "queue");
});

test("submit policy does not auto-submit when manual policy is selected", () => {
  assert.equal(decideVoiceSubmit({
    status: "transcript_ready",
    hasTranscript: true,
    autoSubmit: false,
    chatBusy: false,
    alreadyClaimed: false,
  }), "manual");
});

test("submit policy is idempotent after a request has been claimed", () => {
  assert.equal(decideVoiceSubmit({
    status: "transcript_ready",
    hasTranscript: true,
    autoSubmit: true,
    chatBusy: false,
    alreadyClaimed: true,
  }), "ignore");
});

test("voice UI keeps the transcript draft while queued and exposes manual send", () => {
  assert.match(storeSource, /voiceSubmitStates/);
  assert.match(storeSource, /voiceSubmissionInFlight/);
  assert.match(overlaySource, /sendVoiceTranscript\(draft\.requestId, draft\.transcript, \{ automatic: true \}\)/);
  assert.match(widgetSource, /Pausa · invio automatico tra circa \$\{VOICE_ENDPOINT_WAIT_SECONDS\} s/);
  assert.match(widgetSource, /Pausa · premi Invia per terminare/);
  assert.match(widgetSource, /Preparazione invio…/);
  assert.match(widgetSource, /Trascrizione…/);
  assert.match(widgetSource, /In coda · invio appena libero/);
  assert.match(widgetSource, /Pronto · premi Invia/);
  assert.match(widgetSource, /Termina e invia/);
  assert.match(widgetSource, /Invia ora/);
  assert.match(widgetSource, /endpointingEnabled/);
  assert.match(widgetSource, /shouldShowVoiceSendControl/);
});

test("barge-in never exposes a forced manual send control", () => {
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: true,
    transcriptReady: false,
    bargeIn: true,
  }), false);
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: false,
    transcriptReady: true,
    bargeIn: true,
  }), false);
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: true,
    transcriptReady: false,
    bargeIn: false,
  }), true);
});

test("barge-in auto-arm is restricted to VAD and does not call chat cancellation", () => {
  assert.match(overlaySource, /const bargeInReady = vadFallbackReady/);
  assert.match(overlaySource, /const liveBargeInReady = liveVadFallbackReady/);
  assert.match(overlaySource, /const startBargeIn = useCallback/);
  assert.match(overlaySource, /const currentTtsStatus = useJarvisStore\.getState\(\)\.ttsStatus\.status/);
  assert.match(overlaySource, /if \(ttsActive && requestId\) setBargeInRequestId/);
  assert.match(overlaySource, /bargeIn={bargeInRequestId === voiceRequest\?\.requestId}/);
  assert.match(overlaySource, /activationMode: VoiceActivationMode = "vad"/);
  assert.doesNotMatch(overlaySource, /cancelChat\(/);
});

test("Edge TTS normalizes at the single speak boundary", () => {
  assert.match(ttsSource, /pub fn normalize_for_speech\(/);
  assert.match(commandsSource, /normalize_for_speech\(&request\.text,\s*config\.max_spoken_chars\)/);
});

test("endpointing is configurable and wired to automatic voice stop", () => {
  assert.match(settingsSource, /endpoint_grace_ms/);
  assert.match(settingsSource, /min_spoken_ms/);
  assert.match(settingsSource, /fn default_vad_post_speech_ms\(\)[\s\S]*MIN_SAFE_VAD_POST_SPEECH_MS/);
  assert.match(settingsSource, /vad_post_speech_ms = settings[\s\S]*\.max\(MIN_SAFE_VAD_POST_SPEECH_MS\)/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_WAIT_MS = 3_000/);
  assert.match(frontendSettingsSource, /vadPostSpeechMs: Math\.max\([\s\S]*VOICE_ENDPOINT_WAIT_MS/);
  assert.match(commandsSource, /EndpointingConfig/);
  assert.match(commandsSource, /finish_voice_stop\(/);
  assert.match(vadSource, /NOISE_GATE_RATIO/);
  assert.match(vadSource, /NOISE_CALIBRATION_MS: u64 = 300/);
  assert.match(vadSource, /STRONG_SPEECH_RATIO/);
  assert.match(vadSource, /fn update_noise_floor/);
  assert.match(captureSource, /vad_pre_roll_ms: 500/);
  assert.match(voiceTypesSource, /force_endpointing: bool/);
  assert.match(commandsSource, /watchdog_config\.endpointing_enabled \|= force_endpointing/);
  assert.match(storeSource, /forceEndpointing: options\.forceEndpointing/);
});

test("barge-in owns only the TTS cancellation token", () => {
  const voiceHandoffStart = storeSource.lastIndexOf("setVoiceRequest:");
  const voiceHandoffEnd = storeSource.indexOf("applyActivityEvents:", voiceHandoffStart);
  assert.ok(voiceHandoffStart >= 0 && voiceHandoffEnd > voiceHandoffStart);
  const voiceHandoff = storeSource.slice(voiceHandoffStart, voiceHandoffEnd);
  assert.match(voiceHandoff, /ttsStop\(\)/);
  assert.doesNotMatch(voiceHandoff, /cancelChat\(/);
  assert.match(commandsSource, /request_stop_tts_if_current\(/);
});
