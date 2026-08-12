import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideVoiceSubmit,
} from "../src/lib/jarvis/voiceState.ts";

const storeSource = readFileSync(new URL("../src/stores/jarvisStore.ts", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/components/jarvis/JarvisGlobalOverlay.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../src/components/jarvis/JarvisWidget.tsx", import.meta.url), "utf8");

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
