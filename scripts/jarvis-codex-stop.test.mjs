import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCodexChatStream,
  interruptStreamingTurnsForRequest,
  isCodexTurnActive,
  reconcileStreamingTurnsWithThreads,
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

function thread(overrides = {}) {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    createdAt: 0,
    status: "idle",
    activeTurnId: null,
    ...overrides,
  };
}

function startTurn(turnId, requestId = "request-1", workspaceId = "workspace-1") {
  return event("turn_started", { turnId, requestId, workspaceId });
}

test("a new turn supersedes a still-active previous turn of the same workspace", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  turns = applyCodexChatStream(
    turns,
    event("message_completed", { turnId: "turn-1", itemId: "commentary-1", text: "Controllo." }),
  );
  turns = applyCodexChatStream(turns, startTurn("turn-2", "request-2"));

  const list = turns["workspace-1"];
  assert.equal(list[0].turnId, "turn-2");
  assert.equal(list[0].status, "active");
  const previous = list.find((turn) => turn.turnId === "turn-1");
  assert.equal(previous?.status, "interrupted");
  assert.equal(previous?.endedAt, "2026-08-14T20:00:00.000Z");
  assert.equal(isCodexTurnActive(turns, "workspace-1"), true);
});

test("a repeated turn_started for the same turn never kills it", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  assert.equal(turns["workspace-1"][0].status, "active");
});

test("a superseded turn in another workspace is left untouched", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-a", "request-a", "workspace-A"));
  turns = applyCodexChatStream(turns, startTurn("turn-b", "request-b", "workspace-B"));
  assert.equal(turns["workspace-A"][0].status, "active");
  assert.equal(turns["workspace-B"][0].status, "active");
});

test("reconcile retires a local active turn when the thread is idle", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  const { turns: next, interrupted } = reconcileStreamingTurnsWithThreads(
    turns,
    { "workspace-1": thread({ status: "idle", activeTurnId: null }) },
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(next["workspace-1"][0].status, "interrupted");
  assert.deepEqual(interrupted, [{ workspaceId: "workspace-1", turnId: "turn-1" }]);
  assert.equal(isCodexTurnActive(next, "workspace-1"), false);
});

test("reconcile keeps the turn the backend still advertises and retires older ones", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  turns = applyCodexChatStream(turns, startTurn("turn-2", "request-2"));
  // Simulate a missed supersede: both look active locally.
  turns = {
    "workspace-1": [
      { ...turns["workspace-1"][0], status: "active" },
      { ...turns["workspace-1"][1], status: "active" },
    ],
  };
  const { turns: next, interrupted } = reconcileStreamingTurnsWithThreads(
    turns,
    { "workspace-1": thread({ status: "in_progress", activeTurnId: "turn-2" }) },
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(next["workspace-1"][0].status, "active");
  assert.equal(next["workspace-1"][1].status, "interrupted");
  assert.deepEqual(interrupted, [{ workspaceId: "workspace-1", turnId: "turn-1" }]);
});

test("reconcile never touches workspaces without a thread record", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  const { turns: next, interrupted } = reconcileStreamingTurnsWithThreads(
    turns,
    {},
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(next["workspace-1"][0].status, "active");
  assert.deepEqual(interrupted, []);
});

test("reconcile is a no-op without active turns", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  turns = applyCodexChatStream(turns, event("turn_completed", { turnId: "turn-1" }));
  const { turns: next, interrupted } = reconcileStreamingTurnsWithThreads(
    turns,
    { "workspace-1": thread({ status: "idle", activeTurnId: null }) },
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(next["workspace-1"][0].status, "completed");
  assert.deepEqual(interrupted, []);
});

test("cancel retires only the active turns owned by the cancelled request", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1", "request-1"));
  turns = applyCodexChatStream(turns, startTurn("turn-2", "request-2"));
  // Both active locally (missed supersede); cancel targets the older request.
  turns = {
    "workspace-1": [
      { ...turns["workspace-1"][0], status: "active" },
      { ...turns["workspace-1"][1], status: "active" },
    ],
  };
  const { turns: next, interrupted } = interruptStreamingTurnsForRequest(
    turns,
    "workspace-1",
    "request-1",
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(
    next["workspace-1"].find((turn) => turn.turnId === "turn-1")?.status,
    "interrupted",
  );
  assert.equal(
    next["workspace-1"].find((turn) => turn.turnId === "turn-2")?.status,
    "active",
  );
  assert.deepEqual(interrupted, [{ workspaceId: "workspace-1", turnId: "turn-1" }]);
});

test("cancel with an unknown request id changes nothing", () => {
  let turns = {};
  turns = applyCodexChatStream(turns, startTurn("turn-1"));
  const { turns: next, interrupted } = interruptStreamingTurnsForRequest(
    turns,
    "workspace-1",
    "request-missing",
    "2026-08-14T20:01:00.000Z",
  );
  assert.equal(next["workspace-1"][0].status, "active");
  assert.deepEqual(interrupted, []);
});

test("an interrupted turn settles only its own pending speech", async () => {
  const { enqueueSpeech, settleSpeechForTurn } = await import("../src/lib/jarvis/ttsState.ts");
  let queue = enqueueSpeech([], {
    itemId: "m-1", turnId: "turn-1", workspaceId: "workspace-1", text: "Vecchio turno.",
  });
  queue = enqueueSpeech(queue, {
    itemId: "m-2", turnId: "turn-2", workspaceId: "workspace-1", text: "Turno corrente.",
  });
  queue = settleSpeechForTurn(queue, "workspace-1", "turn-1", null);
  assert.deepEqual(queue.map((item) => item.turnId), ["turn-2"]);
});

test("stop wiring: thread snapshot reconciles, interrupt reloads threads, cancel refreshes confirmations", async () => {
  const { readFileSync } = await import("node:fs");
  const eventBinding = readFileSync(new URL("../src/stores/jarvis/eventBinding.ts", import.meta.url), "utf8");
  const codexSlice = readFileSync(new URL("../src/stores/jarvis/codexSlice.ts", import.meta.url), "utf8");
  const chatSlice = readFileSync(new URL("../src/stores/jarvis/chatSlice.ts", import.meta.url), "utf8");
  const overlay = readFileSync(new URL("../src/components/jarvis/JarvisGlobalOverlay.tsx", import.meta.url), "utf8");

  // Thread snapshots (event + explicit reload) retire stale active turns.
  assert.match(eventBinding, /reconcileStreamingTurnsWithThreads/);
  assert.match(codexSlice, /reconcileStreamingTurnsWithThreads/);
  // A repeated stop converges instead of leaving a stale active row.
  assert.match(codexSlice, /interruptCodexTurn[\s\S]*loadCodexThreads/);
  // Cancel retires only its own request turns, settles their speech, and
  // reloads authoritative confirmations + threads.
  assert.match(chatSlice, /interruptStreamingTurnsForRequest/);
  assert.match(chatSlice, /cancelChatRequest[\s\S]*refreshPendingActions/);
  assert.match(chatSlice, /cancelChatRequest[\s\S]*loadCodexThreads/);
  // Returning to a workspace reconciles its turn status immediately.
  assert.match(overlay, /loadCodexThreads/);
});
