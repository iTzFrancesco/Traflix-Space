import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideVoiceSubmit,
} from "../src/lib/jarvis/voiceState.ts";

const storeSource = readFileSync(new URL("../src/stores/jarvisStore.ts", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/components/jarvis/JarvisGlobalOverlay.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../src/components/jarvis/JarvisWidget.tsx", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/commands.rs", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src-tauri/src/settings/store.rs", import.meta.url), "utf8");
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
  assert.match(widgetSource, /Pausa — puoi continuare/);
  assert.match(widgetSource, /Preparazione invio…/);
  assert.match(widgetSource, /Trascrizione…/);
  assert.match(widgetSource, /In coda…/);
  assert.match(widgetSource, /Pronto — Invia adesso/);
});

test("barge-in auto-arm is restricted to VAD and does not call chat cancellation", () => {
  assert.match(overlaySource, /const bargeInReady = vadFallbackReady/);
  assert.match(overlaySource, /const liveBargeInReady = liveVadFallbackReady/);
  assert.doesNotMatch(overlaySource, /cancelChat\(/);
});

test("Edge TTS normalizes at the single speak boundary", () => {
  assert.match(ttsSource, /pub fn normalize_for_speech\(/);
  assert.match(commandsSource, /normalize_for_speech\(&request\.text,\s*config\.max_spoken_chars\)/);
});

test("endpointing is configurable and wired to automatic voice stop", () => {
  assert.match(settingsSource, /endpoint_grace_ms/);
  assert.match(settingsSource, /min_spoken_ms/);
  assert.match(commandsSource, /EndpointingConfig/);
  assert.match(commandsSource, /finish_voice_stop\(/);
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
