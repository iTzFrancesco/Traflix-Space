import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideVoiceSubmit,
  shouldShowVoiceSendControl,
  voiceEndpointCaption,
} from "../src/lib/jarvis/voiceState.ts";
import { normalizeVoiceEndpointWaitMs } from "../src/lib/jarvis/settings.ts";
import {
  enqueueSpeech,
  shouldSpeakCommentary,
} from "../src/lib/jarvis/ttsState.ts";

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
const frontendTypesSource = readFileSync(new URL("../src/lib/jarvis/types.ts", import.meta.url), "utf8");

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

test("a failed transcript submission is claimed and never re-auto-submits", () => {
  assert.match(storeSource, /\["sent", "submitting", "failed"\]/);
  assert.match(storeSource, /\[requestId\]: "failed"/);
  assert.match(storeSource, /\[requestId\]: chatError \? "queued" : "failed"/);
  assert.match(frontendTypesSource, /VoiceSubmitState = "manual" \| "queued" \| "submitting" \| "sent" \| "failed"/);
  assert.match(storeSource, /submitState === "sent" \|\| submitState === "submitting"/);
});

test("voice UI keeps the transcript draft while queued and exposes manual send", () => {
  assert.match(storeSource, /voiceSubmitStates/);
  assert.match(storeSource, /voiceSubmissionInFlight/);
  assert.match(overlaySource, /sendVoiceTranscript\(draft\.requestId, draft\.transcript, \{ automatic: true \}\)/);
  assert.match(widgetSource, /Preparazione invio…/);
  assert.match(widgetSource, /Trascrizione…/);
  assert.match(widgetSource, /In coda · invio appena libero/);
  assert.match(widgetSource, /Pronto · premi Invia/);
  assert.match(widgetSource, /Termina e invia/);
  assert.match(widgetSource, /Invia ora/);
  assert.match(widgetSource, /shouldShowVoiceSendControl/);
});

test("automatic submit waits for the final transcript after pause and resume", () => {
  for (const status of ["armed", "recording", "stopping", "transcribing"]) {
    assert.equal(decideVoiceSubmit({
      status,
      hasTranscript: true,
      autoSubmit: true,
      chatBusy: false,
      alreadyClaimed: false,
    }), "ignore", `capture status ${status} must not send to Codex`);
  }
  assert.equal(decideVoiceSubmit({
    status: "transcript_ready",
    hasTranscript: true,
    autoSubmit: true,
    chatBusy: false,
    alreadyClaimed: false,
  }), "send");
});

test("voice caption distinguishes pause, finalizing, speech and standby", () => {
  assert.equal(voiceEndpointCaption("speaking"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("pause"), "Pausa naturale · continuo ad ascoltare");
  assert.equal(voiceEndpointCaption("breath"), "Respiro · tengo aperto l'ascolto");
  assert.equal(voiceEndpointCaption("micro_interruption"), "Micro-interruzione · verifico la ripresa");
  assert.equal(voiceEndpointCaption("finalizing"), "Fine frase · attendo il silenzio");
  assert.equal(voiceEndpointCaption("standby"), "Pronto · rumore filtrato");
});

test("endpoint wait is configurable, migrated and bounded", () => {
  assert.equal(normalizeVoiceEndpointWaitMs(1_200), 6_500);
  assert.equal(normalizeVoiceEndpointWaitMs(4_000), 4_000);
  assert.equal(normalizeVoiceEndpointWaitMs(1_000), 3_500);
  assert.equal(normalizeVoiceEndpointWaitMs(20_000), 15_000);
});

test("progressive TTS does not discard a short completed intermediate step", () => {
  assert.equal(shouldSpeakCommentary("Ok."), true);
});

test("progressive TTS retains every completed step until the worker consumes it", () => {
  let queue = [];
  for (let index = 0; index < 10; index += 1) {
    queue = enqueueSpeech(queue, {
      itemId: `item-${index}`,
      turnId: "turn-1",
      workspaceId: "workspace-1",
      text: `Step ${index}`,
    });
  }
  assert.deepEqual(queue.map((item) => item.itemId), Array.from(
    { length: 10 },
    (_, index) => `item-${index}`,
  ));
});

test("voice widget keeps a stable listening label while VAD samples change", () => {
  assert.doesNotMatch(widgetSource, /props\.voiceRequest\.vadState\s*===/);
  assert.match(widgetSource, /voiceEndpointCaption/);
  assert.match(widgetSource, /endpointState/);
  assert.match(widgetSource, /voiceListening = props\.voiceRequest\?\.status === "recording"/);
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
  assert.doesNotMatch(overlaySource, /interruptTts/);
  assert.doesNotMatch(overlaySource, /cancelChat\(/);
});

test("arming barge-in does not cancel TTS before speech is confirmed", () => {
  const startVoiceStart = storeSource.indexOf("  startVoice: async");
  const startVoiceEnd = storeSource.indexOf("  stopVoice:", startVoiceStart);
  assert.ok(startVoiceStart >= 0 && startVoiceEnd > startVoiceStart);
  const startVoiceBlock = storeSource.slice(startVoiceStart, startVoiceEnd);
  assert.doesNotMatch(startVoiceBlock, /interruptTts/);
  assert.doesNotMatch(startVoiceBlock, /void get\(\)\.stopTts\(\)/);
  assert.match(startVoiceBlock, /forceEndpointing: options\.forceEndpointing/);
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
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_WAIT_MS = 6_500/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_MIN_WAIT_MS = 3_500/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_MAX_WAIT_MS = 15_000/);
  assert.match(frontendSettingsSource, /endpointGraceMs: normalizeVoiceEndpointWaitMs/);
  assert.match(frontendSettingsSource, /vadPostSpeechMs: VOICE_VAD_CANDIDATE_MS/);
  assert.match(commandsSource, /EndpointingConfig/);
  assert.match(commandsSource, /finish_voice_stop\(/);
  assert.match(vadSource, /NOISE_GATE_RATIO/);
  assert.match(vadSource, /NOISE_FLOOR_TRACK_ALPHA/);
  assert.match(vadSource, /NOISE_CALIBRATION_MS: u64 = 300/);
  assert.match(vadSource, /STRONG_SPEECH_RATIO/);
  assert.match(vadSource, /RESUME_FRAME_COUNT/);
  assert.match(vadSource, /fn update_noise_floor/);
  assert.match(vadSource, /fn noise_gate_threshold/);
  assert.match(captureSource, /apply_noise_gate/);
  assert.match(captureSource, /vad_pre_roll_ms: 500/);
  assert.match(commandsSource, /endpoint_state: status\.endpoint_state/);
  assert.match(voiceTypesSource, /enum VoiceEndpointState/);
  assert.match(frontendTypesSource, /VoiceEndpointState/);
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
