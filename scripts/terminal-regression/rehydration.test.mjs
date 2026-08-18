import assert from "node:assert/strict";
import test from "node:test";
import { terminalPane, outputChunk } from "./shared.mjs";
test("canonical terminal order keeps persisted UI order and sorts runtime-only extras", async () => {
  const { canonicalTerminalIds } = await import("../../src/lib/terminalOrdering.ts");
  assert.deepEqual(
    canonicalTerminalIds(
      ["right", "left", "removed", "right"],
      ["runtime-z", "left", "right", "runtime-a"],
    ),
    ["right", "left", "runtime-a", "runtime-z"],
  );
  assert.deepEqual(canonicalTerminalIds([], ["b", "a", "b"]), ["a", "b"]);
  assert.deepEqual(
    canonicalTerminalIds(
      [],
      ["\u{10000}-extra", "ä-extra", "a-extra", "Z-extra", "A-extra", "\uE000-extra"],
    ),
    ["A-extra", "Z-extra", "a-extra", "ä-extra", "\uE000-extra", "\u{10000}-extra"],
    "runtime extras must use the same locale-independent lexical order as Rust",
  );
});

test("workspace switching preserves pane selection and focus for agents and plain PowerShell", async () => {
  const { useTerminalStore } = await import("../../src/stores/terminalStore.ts");
  useTerminalStore.setState({
    terminals: {},
    terminalOrderByWorkspace: {},
    activeTerminalByWorkspace: {},
    focusedTerminalByWorkspace: {},
    activeTerminalId: null,
    focusedTerminalId: null,
    terminalTitles: {},
    draggedTerminalId: null,
    dragHoveredTerminalId: null,
  });
  const store = useTerminalStore.getState();
  for (const terminal of [
    { id: "plain-a", workspaceId: "workspace-a", agent: null },
    { id: "agent-a", workspaceId: "workspace-a", agent: "codex" },
    { id: "plain-b", workspaceId: "workspace-b", agent: null },
  ]) {
    store.addTerminal({
      ...terminal,
      shell: "powershell.exe",
      cwd: `C:\\${terminal.workspaceId}`,
      title: terminal.id,
    });
  }
  store.syncWorkspaceTerminalOrder("workspace-a", ["plain-a", "agent-a"]);
  store.syncWorkspaceTerminalOrder("workspace-b", ["plain-b"]);
  store.setActiveTerminal("agent-a");
  store.setFocusedTerminal("agent-a");

  store.restoreWorkspaceSelection("workspace-b", ["plain-b"]);
  assert.equal(useTerminalStore.getState().activeTerminalId, "plain-b");
  assert.equal(useTerminalStore.getState().focusedTerminalId, null);
  assert.equal(
    useTerminalStore.getState().activeTerminalByWorkspace["workspace-a"],
    "agent-a",
  );
  assert.equal(
    useTerminalStore.getState().focusedTerminalByWorkspace["workspace-a"],
    "agent-a",
  );

  // Reorder and 20+ returns cannot replace a valid remembered identity with
  // the first persisted pane.
  for (let index = 0; index < 24; index += 1) {
    store.syncWorkspaceTerminalOrder(
      "workspace-a",
      index % 2 === 0 ? ["agent-a", "plain-a"] : ["plain-a", "agent-a"],
    );
    store.restoreWorkspaceSelection("workspace-a", ["plain-a", "agent-a"]);
    assert.equal(useTerminalStore.getState().activeTerminalId, "agent-a");
    assert.equal(useTerminalStore.getState().focusedTerminalId, "agent-a");
    store.restoreWorkspaceSelection("workspace-b", ["plain-b"]);
  }

  store.restoreWorkspaceSelection("workspace-a", ["plain-a", "agent-a"]);
  store.removeTerminal("agent-a");
  assert.equal(useTerminalStore.getState().activeTerminalId, "plain-a");
  assert.equal(useTerminalStore.getState().focusedTerminalId, null);
  assert.equal(
    useTerminalStore.getState().activeTerminalByWorkspace["workspace-a"],
    "plain-a",
  );
});

test("rehydration replays exactly after the watermark and atomically cuts over", async () => {
  const { TerminalOutputProtocol } = await import(
    "../../src/lib/terminalOutputProtocol.ts"
  );
  const protocol = new TerminalOutputProtocol();
  protocol.startRehydrate({ workspaceId: "workspace-a", generation: 7, processId: 42 });

  protocol.ingest([outputChunk(1, "included"), outputChunk(2, "after")]);
  protocol.installSnapshot(
    { workspaceId: "workspace-a", generation: 7, processId: 42 },
    1,
  );
  const firstReplay = protocol.takeReplay();
  assert.equal(firstReplay.kind, "chunks");
  assert.deepEqual(
    firstReplay.chunks.map((chunk) => new TextDecoder().decode(chunk.data)),
    ["after"],
  );

  // Simulate a callback arriving while xterm asynchronously writes replay 2.
  protocol.ingest([outputChunk(3, "cutover-race")]);
  assert.equal(protocol.cutoverToLive(), false);
  const finalReplay = protocol.takeReplay();
  assert.equal(finalReplay.kind, "chunks");
  assert.deepEqual(
    finalReplay.chunks.map((chunk) => chunk.sequence),
    [3],
  );
  assert.equal(protocol.takeReplay().kind, "empty");
  assert.equal(protocol.cutoverToLive(), true);

  const live = protocol.ingest([outputChunk(4, "live")]);
  assert.deepEqual(live.deliver.map((chunk) => chunk.sequence), [4]);
  assert.equal(live.resyncRequired, false);
});

test("output protocol rejects stale lifetimes, duplicates, and sequence gaps", async () => {
  const { TerminalOutputProtocol } = await import(
    "../../src/lib/terminalOutputProtocol.ts"
  );
  const protocol = new TerminalOutputProtocol();
  protocol.startRehydrate({ workspaceId: "workspace-a", generation: 7, processId: 42 });
  protocol.installSnapshot(
    { workspaceId: "workspace-a", generation: 7, processId: 42 },
    10,
  );
  assert.equal(protocol.cutoverToLive(), true);

  const stale = protocol.ingest([
    outputChunk(11, "old-generation", 6, 42),
    outputChunk(11, "old-process", 7, 41),
    outputChunk(11, "old-workspace", 7, 42, "workspace-b"),
  ]);
  assert.equal(stale.ignored, 3);
  assert.deepEqual(stale.deliver, []);

  const next = protocol.ingest([outputChunk(11, "once")]);
  assert.deepEqual(next.deliver.map((chunk) => chunk.sequence), [11]);
  const duplicate = protocol.ingest([outputChunk(11, "duplicate")]);
  assert.equal(duplicate.ignored, 1);

  const gap = protocol.ingest([outputChunk(13, "gap")]);
  assert.equal(gap.resyncRequired, true);
  assert.equal(protocol.isBuffering(), true);

  // A new generation drops every old buffered byte instead of merging PTYs.
  protocol.startRehydrate({ workspaceId: "workspace-a", generation: 8, processId: 84 });
  protocol.installSnapshot(
    { workspaceId: "workspace-a", generation: 8, processId: 84 },
    2,
  );
  assert.equal(protocol.takeReplay().kind, "empty");
  assert.equal(protocol.cutoverToLive(), true);
  assert.deepEqual(
    protocol.ingest([outputChunk(3, "new", 8, 84)]).deliver.map(
      (chunk) => chunk.sequence,
    ),
    [3],
  );
});

test("failed rehydration stays memory-bounded and exposes deterministic recovery", async () => {
  const { TerminalOutputProtocol } = await import(
    "../../src/lib/terminalOutputProtocol.ts"
  );
  const protocol = new TerminalOutputProtocol();
  protocol.startRehydrate({ workspaceId: "workspace-a", generation: 7, processId: 42 });
  const overflow = protocol.ingest(
    Array.from({ length: 4097 }, (_, index) =>
      outputChunk(index + 1, "x"),
    ),
  );
  assert.equal(overflow.resyncRequired, true);
  assert.equal(protocol.isBuffering(), true);
  assert.throws(() => protocol.takeReplay(), /watermark is not installed/);

  assert.match(terminalPane, /Sincronizzazione terminale interrotta\./);
  assert.match(terminalPane, /handleRetryStreamSync/);
  assert.match(
    terminalPane,
    /xtermRef\.current !== term[\s\S]*sameRuntimeKey\(currentRuntimeKey\(terminalId\), deliveredRuntime\)/,
    "a queued xterm write callback must not mutate an unmounted or reopened pane",
  );
});

