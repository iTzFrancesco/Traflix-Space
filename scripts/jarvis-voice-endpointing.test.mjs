import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideVoiceSubmit,
  shouldShowVoiceSendControl,
  voiceEndpointCaption,
  voiceUiPhase,
} from "../src/lib/jarvis/voiceState.ts";
import {
  normalizeVoiceEndpointWaitMs,
  normalizeVoiceVadPostSpeechMs,
} from "../src/lib/jarvis/settings.ts";
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
const settingsModalSource = readFileSync(new URL("../src/components/layout/SettingsModal.tsx", import.meta.url), "utf8");
const sttSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/stt.rs", import.meta.url), "utf8");

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
  assert.match(widgetSource, /voiceUiPhase/);
  assert.match(widgetSource, /voiceUiLabel/);
  assert.match(widgetSource, /In coda · invio appena libero/);
  assert.match(widgetSource, /Invio a Jarvis…/);
  assert.match(widgetSource, /Termina e invia/);
  assert.match(widgetSource, /Invia ora/);
  assert.match(widgetSource, /activationMode: props\.activationMode/);
  assert.match(widgetSource, /submitState: props\.voiceSubmitState/);
  assert.match(widgetSource, /submitState === "submitting"/);
  assert.match(storeSource, /voiceRequestId: options\.voiceRequestId/);
  assert.match(storeSource, /stale terminal voice event ignored during handoff/);
  assert.match(storeSource, /cancel skipped: voice handoff owns the request/);
  assert.match(storeSource, /chat response won a late local cancellation race/);
  assert.match(storeSource, /voiceRequests\[origin\.workspaceId\]\?\.requestId === requestId/);
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

test("voice caption stays stable across endpoint details", () => {
  assert.equal(voiceEndpointCaption("speaking"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("pause"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("breath"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("micro_interruption"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("finalizing"), "Ti ascolto");
  assert.equal(voiceEndpointCaption("standby", "silence"), "Pronto");
  assert.equal(voiceUiPhase({ status: "recording" }), "listening");
  assert.equal(voiceUiPhase({ status: "transcribing" }), "processing");
});

test("endpoint wait is configurable, migrated and bounded", () => {
  assert.equal(normalizeVoiceEndpointWaitMs(1_200), 900);
  assert.equal(normalizeVoiceEndpointWaitMs(6_500), 900);
  assert.equal(normalizeVoiceEndpointWaitMs(4_000), 4_000);
  assert.equal(normalizeVoiceEndpointWaitMs(400), 500);
  assert.equal(normalizeVoiceEndpointWaitMs(20_000), 5_000);
  assert.equal(normalizeVoiceVadPostSpeechMs(20_000), 5_000);
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

test("Codex commentary stops stale queued speech at a global voice barge-in", () => {
  assert.match(overlaySource, /const activeVoiceRequest = activeVoiceRequestId/);
  assert.match(overlaySource, /const voiceTurnActive = activeVoiceRequest/);
  assert.match(overlaySource, /previousVoiceCaptureRef/);
  assert.match(overlaySource, /queue cleared by barge-in/);
  assert.match(overlaySource, /clearCodexSpeech\(\)/);
});

test("slow transcription is reconciled without an arbitrary cancellation watchdog", () => {
  assert.match(overlaySource, /VOICE_TRANSCRIPTION_RECONCILE_MS = 1_000/);
  assert.match(overlaySource, /voiceWorkspaceStatus\(workspaceId\)/);
  assert.match(overlaySource, /reconciled missed terminal state/);
  assert.doesNotMatch(overlaySource, /VOICE_TRANSCRIPTION_WATCHDOG_MS = 25_000/);
  assert.doesNotMatch(overlaySource, /transcription watchdog cancelling slow request/);
  assert.match(sttSource, /GROQ_STT_TIMEOUT_SECS: u64 = 180/);
  assert.match(sttSource, /\.timeout\(Duration::from_secs\(GROQ_STT_TIMEOUT_SECS\)\)/);
  assert.match(sttSource, /connect_timeout\(Duration::from_secs\(8\)\)/);
});

test("voice widget keeps one stable listening label while VAD samples change", () => {
  assert.doesNotMatch(widgetSource, /props\.voiceRequest\.vadState\s*===/);
  assert.match(widgetSource, /voiceUiPhase/);
  assert.match(widgetSource, /voiceUiLabel/);
  assert.doesNotMatch(widgetSource, /voicePaused|jarvis-pill--paused|endpointState=\{props\.voiceRequest\?\.endpointState\}/);
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

test("manual draft send control disappears once handoff starts", () => {
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: false,
    transcriptReady: true,
    bargeIn: false,
    activationMode: "hold_to_talk",
    submitState: "manual",
    hasTranscript: true,
  }), true);
  for (const submitState of ["queued", "submitting", "sent", "failed"]) {
    assert.equal(shouldShowVoiceSendControl({
      voiceListening: false,
      transcriptReady: true,
      bargeIn: false,
      activationMode: "hold_to_talk",
      submitState,
      hasTranscript: true,
    }), false, submitState);
  }
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: false,
    transcriptReady: true,
    bargeIn: false,
    activationMode: "vad",
    submitState: "manual",
    hasTranscript: true,
  }), false);
  assert.equal(shouldShowVoiceSendControl({
    voiceListening: false,
    transcriptReady: true,
    bargeIn: false,
    activationMode: "hold_to_talk",
    submitState: "manual",
    hasTranscript: false,
  }), false);
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
  assert.match(settingsSource, /vad_post_speech_ms = settings[\s\S]*\.clamp\(MIN_SAFE_VAD_POST_SPEECH_MS, MAX_SAFE_VAD_POST_SPEECH_MS\)/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_WAIT_MS = 900/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_MIN_WAIT_MS = 500/);
  assert.match(frontendSettingsSource, /VOICE_ENDPOINT_MAX_WAIT_MS = 5_000/);
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
  assert.match(commandsSource, /endpoint_state: current\.endpoint_state/);
  assert.match(voiceTypesSource, /enum VoiceEndpointState/);
  assert.match(frontendTypesSource, /VoiceEndpointState/);
  assert.match(voiceTypesSource, /force_endpointing: bool/);
  assert.match(commandsSource, /watchdog_config\.endpointing_enabled\s*=\s*automatic_capture/);
  assert.match(storeSource, /forceEndpointing: options\.forceEndpointing/);
});

test("manual capture keeps long pauses and disables stale VAD endpointing", () => {
  assert.match(settingsModalSource, /hold_to_talk/);
  assert.match(settingsModalSource, /Durata massima acquisizione/);
  assert.match(settingsModalSource, /Fino a 10 minuti/);
  assert.match(frontendSettingsSource, /VOICE_MAX_DURATION_SECONDS = 600/);
  assert.match(commandsSource, /let automatic_capture\s*=\s*activation_mode/);
  assert.match(commandsSource, /vad_enabled: automatic_capture/);
  assert.match(commandsSource, /watchdog_config\.endpointing_enabled\s*=\s*automatic_capture/);
  assert.match(voiceTypesSource, /MAX_RECORDING_MS: u64 = 600_000/);
  assert.match(voiceTypesSource, /MAX_WAV_BYTES: usize = 24 \* 1024 \* 1024/);
  assert.match(voiceTypesSource, /activation_mode[\s\S]*HoldToTalk/);
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
