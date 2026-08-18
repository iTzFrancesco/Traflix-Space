import assert from "node:assert/strict";
import test from "node:test";
import { outputChunk } from "./shared.mjs";
test("32 reopen and workspace-switch cycles never admit stale output or lifecycle events", async () => {
  const { TerminalOutputProtocol } = await import(
    "../../src/lib/terminalOutputProtocol.ts"
  );
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
  store.addTerminal({
    id: "agent",
    workspaceId: "workspace-a",
    shell: "powershell.exe",
    cwd: "C:\\repo-a",
    title: "Agent",
    agent: "codex",
  });
  store.addTerminal({
    id: "anchor",
    workspaceId: "workspace-a",
    shell: "powershell.exe",
    cwd: "C:\\repo-a",
    title: "Anchor",
    agent: null,
  });
  store.addTerminal({
    id: "other",
    workspaceId: "workspace-b",
    shell: "powershell.exe",
    cwd: "C:\\repo-b",
    title: "Other",
    agent: null,
  });

  const protocol = new TerminalOutputProtocol();
  let previousGeneration = null;
  let previousProcessId = null;

  for (let cycle = 1; cycle <= 32; cycle += 1) {
    const generation = 100 + cycle;
    const processId = 1000 + cycle;
    const runtime = { workspaceId: "workspace-a", generation, processId };

    store.markSpawned("agent", "workspace-a", generation, processId);
    store.markBackendAgentLaunch(
      "agent",
      "workspace-a",
      generation,
      processId,
      "starting",
    );
    store.markBackendAgentLaunch(
      "agent",
      "workspace-a",
      generation,
      processId,
      "ready",
    );

    if (previousGeneration !== null && previousProcessId !== null) {
      store.markExited(
        "agent",
        "workspace-a",
        previousGeneration,
        previousProcessId,
        0,
      );
      store.removeTerminal("agent", previousGeneration);
      store.markAgentTurnCompleted("agent", {
        protocol: 1,
        provider: "codex",
        kind: "turn_completed",
        terminalId: "agent",
        workspaceId: "workspace-a",
        generation: previousGeneration,
        processId: previousProcessId,
        eventId: `stale-${cycle}`,
      }, true);
    }

    store.markAgentTurnCompleted("agent", {
      protocol: 1,
      provider: "codex",
      kind: "turn_completed",
      terminalId: "agent",
      workspaceId: "workspace-a",
      generation,
      processId,
      eventId: `current-${cycle}`,
    }, cycle % 2 === 0);

    // Exercise 20+ workspace returns and reorder events while lifecycle events
    // for the previous generation are still arriving.
    store.syncWorkspaceTerminalOrder(
      "workspace-a",
      cycle % 2 === 0 ? ["anchor", "agent"] : ["agent", "anchor"],
    );
    store.setActiveTerminal("other");
    store.setActiveTerminal("agent");

    protocol.startRehydrate(runtime);
    const buffered = [
      outputChunk(1, `snapshot-tail-${cycle}`, generation, processId),
      outputChunk(2, `replay-${cycle}`, generation, processId),
    ];
    if (previousGeneration !== null && previousProcessId !== null) {
      buffered.unshift(
        outputChunk(
          99,
          "stale-output",
          previousGeneration,
          previousProcessId,
        ),
      );
    }
    const ingestion = protocol.ingest(buffered);
    assert.equal(ingestion.deliver.length, 0);
    assert.equal(ingestion.resyncRequired, false);
    protocol.installSnapshot(runtime, 1);
    const replay = protocol.takeReplay();
    assert.equal(replay.kind, "chunks");
    assert.deepEqual(replay.chunks.map((chunk) => chunk.sequence), [2]);
    assert.equal(protocol.takeReplay().kind, "empty");
    assert.equal(protocol.cutoverToLive(), true);
    assert.deepEqual(
      protocol
        .ingest([outputChunk(3, `live-${cycle}`, generation, processId)])
        .deliver.map((chunk) => chunk.sequence),
      [3],
    );

    const current = useTerminalStore.getState().terminals.agent;
    assert.equal(current.generation, generation);
    assert.equal(current.processId, processId);
    assert.equal(current.spawned, true);
    assert.equal(current.backendLaunchState, "ready");
    assert.equal(current.lastAgentCompletion?.eventId, `current-${cycle}`);
    assert.equal(useTerminalStore.getState().activeTerminalId, "agent");
    assert.deepEqual(
      useTerminalStore
        .getState()
        .getByWorkspace("workspace-a")
        .map((terminal) => terminal.id),
      cycle % 2 === 0 ? ["anchor", "agent"] : ["agent", "anchor"],
    );

    previousGeneration = generation;
    previousProcessId = processId;
  }
});

