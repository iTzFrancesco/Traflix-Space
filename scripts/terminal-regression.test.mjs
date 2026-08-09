import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const terminalPane = source("../src/components/workspace/TerminalPane.tsx");
const terminalEvents = source("../src/lib/terminalEvents.ts");
const workspaceView = source("../src/components/workspace/WorkspaceView.tsx");

const outputChunk = (
  sequence,
  text,
  generation = 7,
  processId = 42,
  workspaceId = "workspace-a",
) => ({
  workspaceId,
  generation,
  processId,
  sequence,
  data: new TextEncoder().encode(text),
});

test("terminal output is subscribed and ready before PTY spawn", () => {
  const subscription = terminalPane.indexOf(
    "outputWarmupUnsubRef.current = subscribeTerminalOutput",
  );
  const spawn = terminalPane.indexOf(
    'invoke<TerminalRuntimeIdentity>("terminal_spawn"',
  );
  assert.ok(subscription >= 0, "TerminalPane must subscribe to terminal output");
  assert.ok(spawn >= 0, "TerminalPane must spawn the PTY");
  assert.ok(subscription < spawn, "the first output subscription must precede PTY spawn");
  assert.match(terminalPane, /await waitForTerminalOutputListener\(\)/);
  assert.match(terminalEvents, /export async function waitForTerminalOutputListener/);
  assert.match(terminalEvents, /generation: number/);
  assert.match(terminalEvents, /workspaceId: string/);
  assert.match(terminalPane, /outputProtocolRef\.current\.ingest\(chunks\)/);
  assert.match(terminalPane, /outputProtocolRef\.current\.installSnapshot/);
});

test("window blur cannot send transient two-column PTY resizes", async () => {
  const { isStableTerminalLayout } = await import("../src/lib/terminalPolicies.ts");

  assert.equal(
    isStableTerminalLayout({
      windowFocused: false,
      documentVisible: true,
      width: 500,
      height: 400,
      cols: 80,
      rows: 24,
    }),
    false,
  );
  assert.equal(
    isStableTerminalLayout({
      windowFocused: true,
      documentVisible: true,
      width: 500,
      height: 400,
      cols: 2,
      rows: 24,
    }),
    false,
  );
  assert.equal(
    isStableTerminalLayout({
      windowFocused: true,
      documentVisible: true,
      width: Number.NaN,
      height: 400,
      cols: 80,
      rows: 24,
    }),
    false,
  );
  assert.equal(
    isStableTerminalLayout({
      windowFocused: true,
      documentVisible: true,
      width: 500,
      height: 400,
      cols: 60,
      rows: 24,
    }),
    true,
  );
  assert.equal(
    isStableTerminalLayout({
      windowFocused: true,
      documentVisible: true,
      width: 500,
      height: 400,
      cols: 8,
      rows: 2,
    }),
    true,
  );
  assert.equal(
    isStableTerminalLayout({
      windowFocused: true,
      documentVisible: true,
      width: 500,
      height: 400,
      cols: 8,
      rows: 1,
    }),
    false,
  );
  assert.match(terminalPane, /isStableTerminalLayout\(/);
  const backendSession = source("../src-tauri/src/terminal_engine/session.rs");
  assert.match(backendSession, /MIN_TERMINAL_COLS: u16 = 8/);
  assert.match(backendSession, /MIN_TERMINAL_ROWS: u16 = 2/);
  assert.match(backendSession, /unstable-terminal-layout/);
  const syncStart = terminalPane.indexOf("async function syncMeasuredPtySize");
  const fitStart = terminalPane.indexOf("function fitAndResizePty", syncStart);
  assert.doesNotMatch(
    terminalPane.slice(syncStart, fitStart),
    /enqueuePtyResize\([^)]*fallback/,
    "an unstable measurement must not send a guessed fallback resize",
  );
});

test("PTY generations protect reopen events and manual reopen rehydrates before live output", () => {
  assert.match(terminalEvents, /generation, processId, data, sequence/);
  assert.match(terminalEvents, /Never merge chunks from different PTY lifetimes/);
  assert.match(
    terminalPane,
    /const runtime = await invoke<TerminalRuntimeIdentity>\("terminal_reopen"/,
  );
  assert.match(terminalPane, /expectedGeneration/);
  assert.match(terminalPane, /setRestartToken/);
  assert.match(terminalPane, /terminal_get_screen_text/);
  assert.match(terminalPane, /reopeningRef\.current/);
});

test("backend exit and active-state paths preserve real lifecycle semantics", () => {
  const session = source("../src-tauri/src/terminal_engine/session.rs");
  const manager = source("../src-tauri/src/terminal_engine/mod.rs");
  const commands = source("../src-tauri/src/terminal_engine/commands.rs");
  assert.match(session, /generation: registry_generation/);
  assert.match(session, /status\.exit_code\(\)/);
  assert.doesNotMatch(session, /TerminalExited \{[\s\S]*exit_code: 0,[\s\S]*\}/);
  assert.match(manager, /Validate and recover the target before changing either active marker/);
  assert.match(
    commands,
    /pub async fn terminal_reopen[\s\S]*Result<crate::terminal_engine::TerminalRuntimeIdentity, String>/,
  );
  assert.match(commands, /kill_generation[\s\S]*expected_generation[\s\S]*\.await\?/);
  assert.match(commands, /validate_runtime_identity/);
  assert.match(commands, /workspace_id: String[\s\S]*generation: u64[\s\S]*process_id: Option<u32>/);
});

test("cached workspace re-entry restores an active terminal", () => {
  assert.match(
    workspaceView,
    /activeLoaded[\s\S]*setActiveTerminal\(firstActiveTerminalId\)/,
  );
});

test("drag target overlay never blocks terminal scrollbar input", () => {
  assert.match(
    terminalPane,
    /Full-pane drag overlay[\s\S]*pointerEvents:\s*"none"/,
  );
});

test("workspace teardown saves the last stable scroll intent", () => {
  const cleanupStart = terminalPane.indexOf("disposed = true;");
  const cleanupEnd = terminalPane.indexOf("term.dispose();", cleanupStart);
  assert.ok(cleanupStart >= 0, "terminal cleanup must be present");
  assert.ok(cleanupEnd > cleanupStart, "terminal cleanup must dispose xterm");
  assert.doesNotMatch(
    terminalPane.slice(cleanupStart, cleanupEnd),
    /captureScrollPosition\(/,
    "teardown must not sample transient xterm layout coordinates",
  );
  assert.match(terminalPane, /saving the last known intent is safer/);
  assert.match(terminalPane, /If reflow removed\/truncated the anchor/);
  assert.match(terminalPane, /positionBeforeFit/);
});

test("scroll state preserves bottom, middle, and top while rejecting transient top samples", async () => {
  const {
    positionAfterHiddenOutput,
    positionFromViewport,
    viewportForPosition,
    reconcileScrollSample,
  } = await import("../src/lib/terminalScrollState.ts");

  const bottom = positionFromViewport(1000, 1000);
  const middle = positionFromViewport(1000, 430);
  const top = positionFromViewport(1000, 0);
  assert.deepEqual(bottom, { followsOutput: true, offsetFromBottom: 0 });
  assert.deepEqual(middle, { followsOutput: false, offsetFromBottom: 570 });
  assert.deepEqual(top, { followsOutput: false, offsetFromBottom: 1000 });
  assert.equal(viewportForPosition(1000, bottom), 1000);
  assert.equal(viewportForPosition(1000, middle), 430);
  assert.equal(viewportForPosition(1000, top), 0);
  assert.deepEqual(
    positionAfterHiddenOutput(middle, 1000, 1040),
    { followsOutput: false, offsetFromBottom: 610 },
  );
  assert.equal(positionAfterHiddenOutput(bottom, 1000, 1040), bottom);

  for (const transient of [
    { layoutStable: false, fitInProgress: false },
    { layoutStable: true, fitInProgress: true },
  ]) {
    assert.deepEqual(
      reconcileScrollSample(middle, {
        baseY: 1000,
        viewportY: 0,
        userInitiated: false,
        programmatic: false,
        ...transient,
      }),
      { position: middle, captured: false, repairFollow: false },
    );
  }

  assert.deepEqual(
    reconcileScrollSample(bottom, {
      baseY: 1000,
      viewportY: 0,
      layoutStable: true,
      fitInProgress: false,
      userInitiated: false,
      programmatic: false,
    }),
    { position: bottom, captured: false, repairFollow: true },
  );
  assert.deepEqual(
    reconcileScrollSample(middle, {
      baseY: 1000,
      viewportY: 0,
      layoutStable: true,
      fitInProgress: false,
      userInitiated: true,
      programmatic: false,
    }),
    { position: top, captured: true, repairFollow: false },
  );
});

test("canonical terminal order keeps persisted UI order and sorts runtime-only extras", async () => {
  const { canonicalTerminalIds } = await import("../src/lib/terminalOrdering.ts");
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

test("rehydration replays exactly after the watermark and atomically cuts over", async () => {
  const { TerminalOutputProtocol } = await import(
    "../src/lib/terminalOutputProtocol.ts"
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
    "../src/lib/terminalOutputProtocol.ts"
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
    "../src/lib/terminalOutputProtocol.ts"
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

test("terminal lifecycle rejects stale open, exit, completion, and cross-workspace identity", async () => {
  const backendEvents = source("../src-tauri/src/agent_events.rs");
  const backendManager = source("../src-tauri/src/terminal_engine/mod.rs");
  assert.match(backendEvents, /observe_agent_provider_for_runtime/);
  assert.match(backendEvents, /get_recent_normalized_terminal_text_for_runtime/);
  assert.ok(
    backendEvents.lastIndexOf("validate_runtime_identity") <
      backendEvents.indexOf('app.emit("agent-turn-completed"'),
    "completion identity must be checked again immediately before frontend emission",
  );
  assert.match(backendManager, /stale-terminal-generation: provider target changed/);

  const { useTerminalStore } = await import("../src/stores/terminalStore.ts");
  useTerminalStore.setState({
    terminals: {},
    terminalOrderByWorkspace: {},
    activeTerminalId: null,
    focusedTerminalId: null,
    terminalTitles: {},
    draggedTerminalId: null,
    dragHoveredTerminalId: null,
  });

  const store = useTerminalStore.getState();
  for (const [id, workspaceId] of [
    ["left", "workspace-a"],
    ["right", "workspace-a"],
    ["other", "workspace-b"],
  ]) {
    store.addTerminal({
      id,
      workspaceId,
      shell: "powershell.exe",
      cwd: "C:\\repo",
      title: id,
      agent: id === "other" ? null : "codex",
    });
  }
  store.syncWorkspaceTerminalOrder("workspace-a", ["right", "left"]);
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "starting");
  store.markBackendAgentLaunch("right", "workspace-a", 11, 111, "starting");
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "ready");

  // Reordered/delayed lifecycle events cannot regress a ready launch or move
  // a terminal to another workspace/process.
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "starting");
  store.markBackendAgentLaunch("left", "workspace-a", 10, 999, "failed");
  store.markBackendAgentLaunch("left", "workspace-b", 12, 112, "ready");
  assert.equal(useTerminalStore.getState().terminals.left.backendLaunchState, "ready");
  assert.equal(useTerminalStore.getState().terminals.left.generation, 10);
  assert.equal(useTerminalStore.getState().terminals.left.workspaceId, "workspace-a");

  // Same id, new generation: every old exit/close/completion is inert.
  store.markSpawned("left", "workspace-a", 12, 112);
  store.saveScrollPosition("left", 12, {
    followsOutput: false,
    offsetFromBottom: 4,
  });
  store.markSpawned("left", "workspace-a", 10, 110);
  store.saveScrollPosition("left", 10, {
    followsOutput: false,
    offsetFromBottom: 99,
  });
  store.markExited("left", "workspace-a", 10, 110, 0);
  store.removeTerminal("left", 10);
  store.markAgentTurnCompleted("left", {
    protocol: 1,
    provider: "codex",
    kind: "turn_completed",
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 10,
    processId: 110,
    eventId: "old-completion",
  }, true);
  assert.equal(useTerminalStore.getState().terminals.left.spawned, true);
  assert.equal(useTerminalStore.getState().terminals.left.generation, 12);
  assert.equal(
    useTerminalStore.getState().terminals.left.scrollPosition.offsetFromBottom,
    4,
  );
  assert.equal(useTerminalStore.getState().terminals.left.lastAgentCompletion, null);

  store.markBackendAgentLaunch("left", "workspace-a", 12, 112, "ready");
  store.markAgentTurnCompleted("left", {
    protocol: 1,
    provider: "codex",
    kind: "turn_completed",
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 12,
    processId: 112,
    eventId: "current-completion",
  }, true);
  assert.equal(
    useTerminalStore.getState().terminals.left.lastAgentCompletion?.eventId,
    "current-completion",
  );

  // Persisted order remains primary while two rapid opens and two closes land.
  assert.deepEqual(
    useTerminalStore.getState().getByWorkspace("workspace-a").map((terminal) => terminal.id),
    ["right", "left"],
  );
  store.setActiveTerminal("right");
  store.setFocusedTerminal("right");
  store.removeTerminal("right", 11);
  store.removeTerminal("left", 12);
  assert.equal(useTerminalStore.getState().focusedTerminalId, null);
  assert.equal(useTerminalStore.getState().activeTerminalId, null);
  assert.deepEqual(
    useTerminalStore.getState().getByWorkspace("workspace-b").map((terminal) => terminal.id),
    ["other"],
  );
});

test("workspace load ordering and launch dedupe use the full runtime identity", async () => {
  const {
    acceptsWorkspaceRevision,
    terminalIdentityCollision,
  } = await import("../src/lib/workspaceTerminalProtocol.ts");
  const { agentLaunchKey } = await import("../src/lib/agentLaunchIdentity.ts");

  const refreshed = "2026-08-09T10:00:00.123456789Z";
  const delayedLoad = "2026-08-09T10:00:00.123456788Z";
  assert.equal(acceptsWorkspaceRevision(undefined, refreshed), true);
  assert.equal(acceptsWorkspaceRevision(refreshed, delayedLoad), false);
  assert.equal(acceptsWorkspaceRevision(delayedLoad, refreshed), true);

  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left", "right"],
      { left: { workspaceId: "workspace-a" } },
    ),
    null,
  );
  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left", "left"],
      {},
    ),
    "left",
  );
  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left"],
      { left: { workspaceId: "workspace-b" } },
    ),
    "left",
  );

  const current = agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 12,
    processId: 112,
  });
  assert.notEqual(current, agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 13,
    processId: 113,
  }));
  assert.notEqual(current, agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-b",
    generation: 12,
    processId: 112,
  }));
  assert.match(source("../src/lib/agentLauncher.ts"), /queuedTerminals\.has\(key\)/);
  assert.match(source("../src/lib/agentLauncher.ts"), /agentLaunchOwner === "frontend"/);
  assert.match(source("../src/lib/agentLauncher.ts"), /reportFrontendDiagnostic\("agent-launch-error"/);
  assert.match(source("../src/lib/agentLauncher.ts"), /Impossibile avviare/);
  assert.match(
    source("../src/lib/agentLauncher.ts"),
    /operationId: `agent-launch:\$\{key\}`/,
    "a retry must reuse one generation-scoped idempotency key",
  );
  const terminalManager = source("../src-tauri/src/terminal_engine/mod.rs");
  const terminalSession = source("../src-tauri/src/terminal_engine/session.rs");
  assert.match(terminalManager, /previous_input_operation\(operation_id, data\)/);
  assert.match(terminalManager, /record_input_operation\(operation_id\.to_string\(\), data, Ok\(\(\)\)\)/);
  assert.match(terminalSession, /MAX_INPUT_OPERATIONS: usize = 128/);
  const frame = source("../src-tauri/src/terminal_engine/frame.rs");
  const control = source("../src-tauri/src/jarvis/control.rs");
  assert.match(frame, /agent_launch_owner: Option<String>/);
  assert.match(frame, /agent_launch_state: Option<String>/);
  assert.ok(
    control.indexOf('set_backend_agent_launch_state(&terminal_id, &runtime, "starting")') <
      control.indexOf(".append_terminal(&workspace.id"),
    "backend launch ownership must be durable before the workspace can mount the pane",
  );
  assert.match(
    terminalPane,
    /runtime\.agentLaunchOwner === "backend"[\s\S]*markBackendAgentLaunch/,
  );
});

test("release crash diagnostics are rotating, persistent, and content-free", () => {
  const main = source("../src-tauri/src/main.rs");
  const diagnostics = source("../src-tauri/src/diagnostics.rs");
  const frontendDiagnostics = source("../src/lib/crashDiagnostics.ts");
  assert.match(main, /RollingFileAppender::builder\(\)/);
  assert.match(main, /Rotation::DAILY/);
  assert.match(main, /max_log_files\(7\)/);
  assert.match(main, /install_safe_panic_hook\(\)/);
  assert.match(main, /payload intentionally omitted/);
  assert.match(diagnostics, /There is no[\s\S]*message\/stack field/);
  assert.doesNotMatch(diagnostics, /pub struct FrontendDiagnostic \{[\s\S]*\bmessage:/);
  assert.match(frontendDiagnostics, /window\.addEventListener\("unhandledrejection"/);
  assert.match(terminalPane, /reportFrontendDiagnostic\("terminal-output-resync"/);
});

test("32 reopen and workspace-switch cycles never admit stale output or lifecycle events", async () => {
  const { TerminalOutputProtocol } = await import(
    "../src/lib/terminalOutputProtocol.ts"
  );
  const { useTerminalStore } = await import("../src/stores/terminalStore.ts");

  useTerminalStore.setState({
    terminals: {},
    terminalOrderByWorkspace: {},
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
