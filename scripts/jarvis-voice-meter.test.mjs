import assert from "node:assert/strict";
import test from "node:test";

import {
  responsiveVoiceLevel,
  voiceMeterBarScale,
} from "../src/lib/jarvis/voiceMeter.ts";

test("voice meter keeps normal speech visible without clipping the loud end", () => {
  assert.equal(responsiveVoiceLevel(0), 0);
  assert.ok(responsiveVoiceLevel(0.25) > 0.25);
  assert.ok(responsiveVoiceLevel(0.75) > 0.75);
  assert.equal(responsiveVoiceLevel(1), 1);
});

test("voice meter clamps invalid and out-of-range levels safely", () => {
  assert.equal(responsiveVoiceLevel(-1), 0);
  assert.equal(responsiveVoiceLevel(Number.NaN), 0);
  assert.equal(responsiveVoiceLevel(Number.POSITIVE_INFINITY), 0);
  assert.ok(voiceMeterBarScale(-1, -10, 0) >= 0.12);
  assert.ok(voiceMeterBarScale(2, 100, 0) <= 1);
});

test("voice meter bars keep moving while following the microphone level", () => {
  const firstFrame = voiceMeterBarScale(0.65, 6, 0);
  const nextFrame = voiceMeterBarScale(0.65, 6, 0.7);

  assert.ok(firstFrame > 0.12);
  assert.ok(nextFrame > 0.12);
  assert.notEqual(firstFrame, nextFrame);
});
