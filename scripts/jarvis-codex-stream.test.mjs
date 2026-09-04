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

test("an empty completion event cannot erase accumulated deltas", () => {
  let turns = {};
  for (const incoming of [
    event("turn_started"),
    event("message_started", { itemId: "commentary-1" }),
    event("message_delta", { itemId: "commentary-1", text: "Testo già " }),
    event("message_delta", { itemId: "commentary-1", text: "ricevuto." }),
    event("message_completed", { itemId: "commentary-1", text: "" }),
  ]) {
    turns = applyCodexChatStream(turns, incoming);
  }

  assert.equal(turns["workspace-1"][0].items[0].text, "Testo già ricevuto.");
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

test("a late final item clears an earlier final marker in the same turn", () => {
  let turns = {};
  for (const incoming of [
    event("turn_started"),
    event("message_completed", {
      itemId: "commentary-1",
      text: "Controllo gli agenti.",
    }),
    event("turn_completed"),
    event("message_completed", {
      itemId: "final-1",
      text: "Ecco la risposta.",
    }),
  ]) {
    turns = applyCodexChatStream(turns, incoming);
  }

  const items = turns["workspace-1"][0].items;
  assert.equal(items.find((item) => item.itemId === "commentary-1").final, false);
  assert.equal(items.find((item) => item.itemId === "final-1").final, true);
});

test("a new turn never displays the previous turn message before its first token", () => {
  let turns = {};
  for (const incoming of [
    event("turn_started", { turnId: "turn-1" }),
    event("message_completed", {
      turnId: "turn-1",
      itemId: "final-1",
      text: "Risposta precedente.",
    }),
    event("turn_completed", { turnId: "turn-1" }),
    event("turn_started", { turnId: "turn-2", timestamp: "2026-08-14T20:00:01.000Z" }),
  ]) {
    turns = applyCodexChatStream(turns, incoming);
  }

  assert.equal(latestCodexMessage(turns, "workspace-1"), null);
});

test("speech keys are workspace-scoped so a new workspace never drops its first answer", async () => {
  const { enqueueSpeech, speechItemKey } = await import("../src/lib/jarvis/ttsState.ts");
  const prev = { itemId: "message-1", turnId: "turn-1", workspaceId: "workspace-A", text: "Risposta precedente." };
  const curr = { itemId: "message-1", turnId: "turn-1", workspaceId: "workspace-B", text: "Risposta corrente." };
  assert.notEqual(speechItemKey(prev), speechItemKey(curr));
  let queue = enqueueSpeech([], prev);
  queue = enqueueSpeech(queue, curr);
  assert.equal(queue.length, 2);
  assert.equal(queue[1].text, "Risposta corrente.");
});

test("a new turn preempts pending speech so the current question never hears the previous answer", async () => {
  const { enqueueSpeech, dropStaleSpeechForTurn } = await import("../src/lib/jarvis/ttsState.ts");
  let queue = enqueueSpeech([], {
    itemId: "m-1", turnId: "turn-1", workspaceId: "ws-1", text: "Risposta precedente.",
  });
  // New question in the same workspace: pending items from the old turn are stale.
  queue = dropStaleSpeechForTurn(queue, "ws-1", "turn-2");
  assert.deepEqual(queue, []);
  queue = enqueueSpeech(queue, {
    itemId: "m-1", turnId: "turn-2", workspaceId: "ws-1", text: "Risposta corrente.",
  });
  assert.equal(queue[0]?.text, "Risposta corrente.");
});

test("a new turn in another workspace preempts pending speech from the previous workspace", async () => {
  const { enqueueSpeech, dropStaleSpeechForTurn } = await import("../src/lib/jarvis/ttsState.ts");
  let queue = enqueueSpeech([], {
    itemId: "m-1", turnId: "turn-1", workspaceId: "workspace-A", text: "Risposta precedente.",
  });
  queue = dropStaleSpeechForTurn(queue, "workspace-B", "turn-9");
  assert.deepEqual(queue, []);
});

test("a reordered turn_started keeps items already belonging to the new turn", async () => {
  const { dropStaleSpeechForTurn } = await import("../src/lib/jarvis/ttsState.ts");
  const queue = dropStaleSpeechForTurn([{
    itemId: "m-1", turnId: "turn-2", workspaceId: "ws-1", text: "Risposta corrente.",
  }], "ws-1", "turn-2");
  assert.equal(queue.length, 1);
});

test("a new conversation drops only its own pending speech", async () => {
  const { enqueueSpeech, dropSpeechForWorkspace } = await import("../src/lib/jarvis/ttsState.ts");
  let queue = enqueueSpeech([], {
    itemId: "m-1", turnId: "turn-1", workspaceId: "ws-A", text: "Vecchia conversazione.",
  });
  queue = enqueueSpeech(queue, {
    itemId: "m-2", turnId: "turn-7", workspaceId: "ws-B", text: "Altro workspace.",
  });
  queue = dropSpeechForWorkspace(queue, "ws-A");
  assert.deepEqual(queue.map((item) => item.workspaceId), ["ws-B"]);
});

test("turn_started owns the audio channel and a cleared conversation leaves no pending speech", async () => {
  const { readFileSync } = await import("node:fs");
  const eventBindingSource = readFileSync(new URL("../src/stores/jarvis/eventBinding.ts", import.meta.url), "utf8");
  const codexSliceSource = readFileSync(new URL("../src/stores/jarvis/codexSlice.ts", import.meta.url), "utf8");
  assert.match(eventBindingSource, /dropStaleSpeechForTurn/);
  assert.match(eventBindingSource, /payload\.kind === "turn_started"/);
  assert.match(codexSliceSource, /dropSpeechForWorkspace\(state\.codexSpeechQueue, workspaceId\)/);
  assert.match(codexSliceSource, /delete codexStreamingTurns\[workspaceId\]/);
});
