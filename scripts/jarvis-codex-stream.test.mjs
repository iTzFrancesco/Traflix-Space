import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCodexChatStream,
  completedCodexSpeechItem,
  latestCodexMessage,
} from "../src/lib/jarvis/chatState.ts";

const base = {
  requestId: "request-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: null,
  text: null,
  toolName: null,
  timestamp: "2026-08-14T20:00:00.000Z",
};

function event(kind, overrides = {}) {
  return { ...base, kind, ...overrides };
}

test("delta-only completion remains visible and is spoken with accumulated text", () => {
  let turns = {};
  let speech = null;

  for (const incoming of [
    event("turn_started"),
    event("message_started", { itemId: "commentary-1" }),
    event("message_delta", { itemId: "commentary-1", text: "Controllo " }),
    event("message_delta", { itemId: "commentary-1", text: "il terminale." }),
    event("message_completed", { itemId: "commentary-1", text: null }),
  ]) {
    turns = applyCodexChatStream(turns, incoming);
    speech = completedCodexSpeechItem(turns, incoming) ?? speech;
  }

  const [turn] = turns["workspace-1"];
  assert.equal(turn.items[0].text, "Controllo il terminale.");
  assert.deepEqual(speech, {
    itemId: "commentary-1",
    turnId: "turn-1",
    workspaceId: "workspace-1",
    text: "Controllo il terminale.",
  });
  assert.equal(latestCodexMessage(turns, "workspace-1"), "Controllo il terminale.");
});

test("intermediate messages and the final answer remain distinct in FIFO order", () => {
  let turns = {};
  const completed = [];

  for (const incoming of [
    event("turn_started"),
    event("message_completed", {
      itemId: "commentary-1",
      text: "Apro il piano.",
    }),
    event("tool_started", { itemId: "tool-1", toolName: "conversational.plan" }),
    event("tool_completed", { itemId: "tool-1", toolName: "conversational.plan" }),
    event("message_completed", {
      itemId: "commentary-2",
      text: "Il piano è completato.",
    }),
    event("turn_completed"),
  ]) {
    turns = applyCodexChatStream(turns, incoming);
    const speech = completedCodexSpeechItem(turns, incoming);
    if (speech) completed.push(speech);
  }

  const items = turns["workspace-1"][0].items;
  assert.deepEqual(completed.map((item) => item.itemId), ["commentary-1", "commentary-2"]);
  assert.equal(items.find((item) => item.itemId === "commentary-2").final, true);
  assert.equal(items.find((item) => item.itemId === "commentary-1").final, false);
});

test("terminal-before-item ordering still marks and speaks the final item", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, event("turn_started"));
  turns = applyCodexChatStream(turns, event("turn_completed"));
  const finalEvent = event("message_completed", {
    itemId: "final-1",
    text: "Risposta finale.",
  });
  turns = applyCodexChatStream(turns, finalEvent);

  const item = turns["workspace-1"][0].items[0];
  assert.equal(item.final, true);
  assert.equal(completedCodexSpeechItem(turns, finalEvent)?.text, "Risposta finale.");
});
