import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const terminalPane = source("../src/components/workspace/TerminalPane.tsx");
const terminalPaneSupport = source("../src/components/workspace/TerminalPaneSupport.ts");
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

test("hidden-window PTY batching is bounded and requests an identity-scoped resync", async () => {
  const {
    affectedTerminalOutputRuntimes,
    isTerminalOutputQueueOverflow,
    MAX_PENDING_OUTPUT_BYTES,
    MAX_PENDING_OUTPUT_CHUNKS,
  } = await import("../src/lib/terminalOutputQueue.ts");
  assert.equal(isTerminalOutputQueueOverflow(MAX_PENDING_OUTPUT_CHUNKS, 1), false);
  assert.equal(isTerminalOutputQueueOverflow(MAX_PENDING_OUTPUT_CHUNKS + 1, 1), true);
  assert.equal(isTerminalOutputQueueOverflow(1, MAX_PENDING_OUTPUT_BYTES), false);
  assert.equal(isTerminalOutputQueueOverflow(1, MAX_PENDING_OUTPUT_BYTES + 1), true);
  assert.deepEqual(
    affectedTerminalOutputRuntimes([
      outputChunk(8, "old", 7, 42),
      outputChunk(9, "old-later", 7, 42),
      outputChunk(1, "new", 8, 84),
    ]),
    [
      { workspaceId: "workspace-a", generation: 7, processId: 42, sequence: 9 },
      { workspaceId: "workspace-a", generation: 8, processId: 84, sequence: 1 },
    ],
  );
  assert.match(terminalEvents, /isTerminalOutputQueueOverflow\(list\.length, queuedBytes\)/);
  assert.match(terminalEvents, /HIDDEN_WINDOW_FLUSH_FALLBACK_MS/);
  assert.match(terminalEvents, /window\.setTimeout\([\s\S]*flushOutput/);
  assert.match(terminalEvents, /resyncReason: "frontend-queue-overflow"/);
  assert.match(
    terminalPane,
    /payload\.resyncRequired[\s\S]*sameRuntimeKey\(currentRuntimeKey\(terminalId\), signaledRuntime\)[\s\S]*startRehydrate\(signaledRuntime\)/,
  );

  const {
    cancelTerminalWrites,
    createTerminalWriteBackpressure,
    MAX_PENDING_XTERM_BYTES,
    releaseTerminalWrite,
    reserveTerminalWrite,
    waitForTerminalWrites,
  } = await import("../src/lib/terminalWriteBackpressure.ts");
  const writes = createTerminalWriteBackpressure();
  assert.equal(reserveTerminalWrite(writes, MAX_PENDING_XTERM_BYTES), true);
  assert.equal(reserveTerminalWrite(writes, 1), false);
  let drained = false;
  const drain = waitForTerminalWrites(writes).then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseTerminalWrite(writes, MAX_PENDING_XTERM_BYTES);
  await drain;
  assert.equal(drained, true);
  assert.equal(reserveTerminalWrite(writes, 1), true);
  const cancelledDrain = waitForTerminalWrites(writes);
  cancelTerminalWrites(writes);
  await cancelledDrain;
  assert.equal(reserveTerminalWrite(writes, 1), false);
  assert.match(
    terminalPane,
    /await waitForTerminalWrites\(xtermWriteBackpressureRef\.current\)[\s\S]*termNow\.reset\(\)/,
    "snapshot reset must drain accepted live xterm writes first",
  );
  assert.match(terminalPane, /xterm-write-backpressure/);
});

test("transient two-column PTY resizes are rejected by the stability probe", async () => {
  const { isStableTerminalLayout } = await import("../src/lib/terminalPolicies.ts");

  assert.equal(
    isStableTerminalLayout({
      documentVisible: false,
      width: 500,
      height: 400,
      cols: 80,
      rows: 24,
    }),
    false,
  );
  assert.equal(
    isStableTerminalLayout({
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
  assert.match(
    terminalPane,
    /const handleRestart = useCallback\(async \(\) => \{[\s\S]*if \(reopeningRef\.current\) return;[\s\S]*reopeningRef\.current = true;/,
    "concurrent restart clicks must share one exact PTY lifetime",
  );
});

test("backend exit and active-state paths preserve real lifecycle semantics", () => {
  const session = source("../src-tauri/src/terminal_engine/session.rs");
  const manager = source("../src-tauri/src/terminal_engine/mod.rs");
  const commands = source("../src-tauri/src/terminal_engine/commands.rs");
  assert.match(session, /generation: registry_generation/);
  assert.match(session, /status\.exit_code\(\)/);
  assert.doesNotMatch(session, /TerminalExited \{[\s\S]*exit_code: 0,[\s\S]*\}/);
  assert.match(manager, /Validate and recover the target before changing either active marker/);
  assert.match(manager, /ensure_spawn_workspace_matches/);
  assert.match(manager, /terminal-workspace-mismatch/);
  assert.match(
    commands,
    /pub async fn terminal_reopen[\s\S]*Result<crate::terminal_engine::TerminalRuntimeIdentity, String>/,
  );
  assert.match(commands, /kill_generation[\s\S]*expected_generation[\s\S]*\.await\?/);
  assert.match(commands, /validate_runtime_identity/);
  assert.match(commands, /workspace_id: String[\s\S]*generation: u64[\s\S]*process_id: Option<u32>/);
  const activeEffect = terminalPane.slice(
    terminalPane.indexOf("// 3. Active focus"),
    terminalPane.indexOf("// 3b. Enter/exit focus mode"),
  );
  assert.match(activeEffect, /runtimeGeneration !== null/);
  assert.match(
    activeEffect,
    /runtimeGeneration,[\s\S]*runtimeProcessId,[\s\S]*terminalWorkspaceId/,
    "backend focus must be reasserted when the initial or reopened PTY identity arrives",
  );
  assert.doesNotMatch(
    terminalPane,
    /Auto-close pane shortly after natural shell exit/,
    "a natural exit must remain restartable until an explicit remove/reopen action",
  );
  assert.match(terminalPane, /getCurrentWebviewWindow\(\)\.isFocused\(\)/);
  assert.match(
    terminalPane,
    /document\.hasFocus\(\) can be false while[\s\S]*xterm owns the focused element/,
  );
});

test("terminal close commits frontend removal only after durable config persistence", () => {
  const manager = source("../src-tauri/src/terminal_engine/mod.rs");
  const commands = source("../src-tauri/src/terminal_engine/commands.rs");
  const closeStart = workspaceView.indexOf("const handleCloseTerminal");
  const closeEnd = workspaceView.indexOf("const handleActivateTerminal", closeStart);
  const closeFlow = workspaceView.slice(closeStart, closeEnd);
  const kill = closeFlow.indexOf('invoke("terminal_kill"');
  const tombstone = closeFlow.indexOf("markExited(", kill);
  const persist = closeFlow.indexOf('invoke<LoadedWorkspace>("terminal_commit_close"', tombstone);
  const remove = closeFlow.indexOf("removeTerminal(", persist);
  assert.ok(kill >= 0 && tombstone > kill && persist > tombstone && remove > persist);
  assert.match(closeFlow, /exactExitedRuntimeAlreadyAbsent/);
  assert.match(closeFlow, /close retry found an already removed runtime/);
  assert.match(
    closeFlow,
    /terminalRuntime\.generation === null[\s\S]*close-before-runtime-ready[\s\S]*return/,
    "a close must not remove config until it can kill one exact PTY lifetime",
  );
  assert.match(
    terminalPane,
    /if \(!isCurrent\(\)\)[\s\S]*disposed-spawn-cleanup/,
    "a spawn completing after real terminal removal must clean up its exact runtime",
  );
  assert.match(
    manager,
    /commit_terminal_close[\s\S]*workspace_lifecycle\.lock\(\)\.await[\s\S]*self\.sessions\.get\(terminal_id\)[\s\S]*remove_terminal_and_save/,
    "config removal must share the spawn barrier and reject a replacement lifetime",
  );
  assert.match(commands, /pub async fn terminal_commit_close/);
});

test("cached workspace re-entry restores its remembered active and focused terminal", () => {
  assert.match(
    workspaceView,
    /activeLoaded[\s\S]*restoreWorkspaceSelection\([\s\S]*activeLoaded\.terminals\.map/,
  );
  const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
  assert.match(workspaceGrid, /activeTerminalByWorkspace\[workspaceId\]/);
  assert.match(workspaceGrid, /focusedTerminalByWorkspace\[workspaceId\]/);
  assert.match(
    workspaceView,
    /activeLoaded\.terminals\.length === 0[\s\S]*terminal_set_active[\s\S]*terminalId: ""/,
  );
});

test("an async terminal add cannot steal selection after a workspace switch", () => {
  const addStart = workspaceView.indexOf("const handleAddTerminal");
  const addEnd = workspaceView.indexOf("// Esponi handleAddTerminal", addStart);
  const addFlow = workspaceView.slice(addStart, addEnd);
  assert.match(
    addFlow,
    /activeWorkspaceId === workspaceId[\s\S]*setActiveTerminal\(newId\)/,
  );
  assert.match(addFlow, /New terminal rollback failed/);
  assert.match(
    addFlow,
    /retainedConfig[\s\S]*syncWorkspaceTerminalOrder[\s\S]*Il terminale è rimasto aperto/,
    "a failed rollback must keep the live PTY visible and retryable",
  );
});

test("closing sibling panes re-arms the mounted pane fit and observes the outer track", () => {
  const resizeStart = terminalPane.indexOf("// 5. ResizeObserver");
  const resizeEnd = terminalPane.indexOf("useTerminalInput", resizeStart);
  const resizeFlow = terminalPane.slice(resizeStart, resizeEnd);
  assert.match(resizeFlow, /observer\.observe\(observed\)/);
  assert.match(resizeFlow, /observed = observed\.parentElement/);
  assert.match(resizeFlow, /level < 5/);
  assert.match(
    resizeFlow,
    /\[terminalId, terminalCount, layoutRevision, focusModeActive, isFocused, scheduleFitAndResize\]/,
    "a mounted pane must fit again when sibling closure changes the grid count",
  );
  assert.match(resizeFlow, /scheduleFitAndResize\(2\)/);
  assert.match(terminalPaneSupport, /export const CONTAINER_STYLE[\s\S]*minWidth: 0[\s\S]*width: "100%"/);
  const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
  assert.match(workspaceGrid, /computeLayout\(terminals\.length\)/);
  assert.match(workspaceGrid, /layoutRevision/);
  assert.match(workspaceGrid, /sidebarWidth/);
  assert.match(workspaceGrid, /sidebarCollapsed/);
  assert.match(workspaceGrid, /height: "100%"/);
  assert.match(workspaceGrid, /padding: isFocusMode[\s\S]*\? 0/);
  assert.match(workspaceGrid, /: \{ display: "none" \}/);
  assert.doesNotMatch(workspaceGrid, /width: 1,[\s\S]*height: 1/);
  assert.match(source("../src/App.tsx"), /<main className="min-w-0 flex-1/);
});

test("fullscreen and close transitions cannot retain stale grid tracks or an empty hidden cell", () => {
  const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
  assert.match(
    workspaceGrid,
    /The persisted layout is a creation hint[\s\S]*computeLayout\(terminals\.length\)/,
    "grid dimensions must follow the rendered terminal list, not cached rows/cols",
  );
  assert.match(
    workspaceGrid,
    /isFocusMode[\s\S]*\? 0[\s\S]*gridTemplateColumns: isFocusMode \? "1fr"/,
    "fullscreen must use the whole workspace content box",
  );
  assert.match(
    workspaceGrid,
    /isFocused[\s\S]*display: "none"/,
    "non-focused panes must not reserve a one-pixel grid track",
  );
  const terminalPaneSource = terminalPane.slice(
    terminalPane.indexOf("// 5. ResizeObserver"),
    terminalPane.indexOf("useTerminalInput(", terminalPane.indexOf("// 5. ResizeObserver")),
  );
  assert.match(
    terminalPaneSource,
    /bounded two-frame barrier[\s\S]*scheduleFitAndResize\(2\)/,
    "layout transitions must wait for the settled grid before fitting xterm",
  );
  assert.match(
    terminalPaneSource,
    /window\.addEventListener\("resize", onWindowResize\)[\s\S]*window\.removeEventListener\("resize", onWindowResize\)/,
    "window maximize/restore must re-arm the debounced fit as a guaranteed trigger",
  );
  assert.match(
    terminalPaneSource,
    /const onWindowResize = \(\) => \{[\s\S]*scheduleFitAndResize\(0\);/,
    "a window resize must arm the fit immediately without waiting for the observer debounce",
  );
  assert.match(
    terminalPaneSource,
    /terminal-resize-guard-error[\s\S]*resize-observer-callback[\s\S]*scheduleFitAndResize\(2\);/,
    "an observer callback exception must be reported and still arm the fit",
  );
  assert.match(
    terminalPane,
    /layoutRevision[\s\S]*scheduleFitAndResize\(2\)/,
    "the pane must receive an explicit layout epoch in addition to ResizeObserver",
  );
  assert.match(terminalPaneSupport, /MAX_LAYOUT_FIT_RETRY_FRAMES = 5/);
  assert.match(
    terminalPane,
    /let fitted = false;[\s\S]*fitted = fitAndResizePty\([\s\S]*if \(!fitted && schedule\.retryFrames > 0\)[\s\S]*schedule\.retryFrames -= 1/,
    "a transient grid measurement must get bounded frame retries instead of waiting for a later click",
  );
  assert.match(
    terminalPane,
    /terminal-fit-error[\s\S]*state: "fit-callback"[\s\S]*retryWhileSettling\(\);/,
    "a measurement exception must re-arm the fit inside the settle window instead of killing the loop",
  );
  assert.match(
    terminalPaneSupport,
    /MAX_LAYOUT_SETTLE_MS = 1500/,
    "explicit layout transitions must keep a bounded settle window",
  );
  assert.match(
    terminalPane,
    /waitFrames > 0[\s\S]*schedule\.deadline = Math\.max\([\s\S]*MAX_LAYOUT_SETTLE_MS/,
    "an explicit transition must arm the settle deadline",
  );
  assert.match(
    terminalPane,
    /const retryWhileSettling = \(\) => \{[\s\S]*performance\.now\(\) < schedule\.deadline[\s\S]*requestAnimationFrame\(run\)/,
    "a failed fit must re-arm while the transition is still settling",
  );
  assert.match(
    terminalPane,
    /rehydratingRef\.current\) \{[\s\S]*schedule\.retryFrames = 0;[\s\S]*retryWhileSettling\(\);/,
    "rehydrate and focus bails must retry inside the settle window instead of abandoning the fit",
  );
  assert.match(
    terminalPane,
    /document\.visibilityState === "hidden"\) \{[\s\S]*retryWhileSettling\(\);/,
    "a hidden document must pause the fit inside the settle window instead of abandoning it",
  );
});

test("four-pane geometry collapses deterministically after each close", async () => {
  const { computeLayout } = await import("../src/lib/presets.ts");
  assert.deepEqual(computeLayout(4), { rows: 2, cols: 2 });
  assert.deepEqual(computeLayout(3), { rows: 1, cols: 3 });
  assert.deepEqual(computeLayout(2), { rows: 1, cols: 2 });
  assert.deepEqual(computeLayout(1), { rows: 1, cols: 1 });
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
    positionAfterUnmountedOutput,
    positionFromViewport,
    viewportForPosition,
    reconcileScrollSample,
  } = await import("../src/lib/terminalScrollState.ts");

  const bottom = positionFromViewport(1000, 1000);
  const middle = positionFromViewport(1000, 430);
  const top = positionFromViewport(1000, 0);
  assert.deepEqual(bottom, { followsOutput: true, offsetFromBottom: 0 });
  assert.deepEqual(middle, {
    followsOutput: false,
    offsetFromBottom: 570,
    baseYAtCapture: 1000,
  });
  assert.deepEqual(top, {
    followsOutput: false,
    offsetFromBottom: 1000,
    baseYAtCapture: 1000,
  });
  assert.equal(viewportForPosition(1000, bottom), 1000);
  assert.equal(viewportForPosition(1000, middle), 430);
  assert.equal(viewportForPosition(1000, top), 0);
  assert.deepEqual(
    positionAfterHiddenOutput(middle, 1000, 1040),
    { followsOutput: false, offsetFromBottom: 610, baseYAtCapture: 1040 },
  );
  assert.equal(positionAfterHiddenOutput(bottom, 1000, 1040), bottom);
  const afterUnmountedOutput = positionAfterUnmountedOutput(middle, 1040);
  assert.deepEqual(afterUnmountedOutput, {
    followsOutput: false,
    offsetFromBottom: 610,
    baseYAtCapture: 1040,
  });
  assert.equal(viewportForPosition(1040, afterUnmountedOutput), 430);
  const queuedHiddenWrite = positionAfterHiddenOutput(
    positionAfterHiddenOutput(middle, 1000, 1010),
    1010,
    1020,
  );
  assert.deepEqual(queuedHiddenWrite, {
    followsOutput: false,
    offsetFromBottom: 590,
    baseYAtCapture: 1020,
  });

  for (const transient of [
    { layoutStable: false, fitInProgress: false, rehydrating: false },
    { layoutStable: true, fitInProgress: true, rehydrating: false },
    { layoutStable: true, fitInProgress: false, rehydrating: true },
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
      rehydrating: false,
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
      rehydrating: false,
      userInitiated: true,
      programmatic: false,
    }),
    { position: top, captured: true, repairFollow: false },
  );
});

test("programmatic scroll guards expire deterministically and TUI input does not change viewport intent", async () => {
  const {
    cancelProgrammaticScroll,
    isTerminalViewportNavigationKey,
    runProgrammaticScroll,
    shouldTrackTerminalWheel,
  } = await import("../src/lib/terminalScrollState.ts");

  const guard = { epoch: 0, target: null };
  const deferred = [];
  runProgrammaticScroll(
    guard,
    () => {},
    () => 41,
    (clear) => deferred.push(clear),
  );
  assert.equal(guard.target, 41);
  deferred.shift()();
  assert.equal(guard.target, null);

  runProgrammaticScroll(
    guard,
    () => cancelProgrammaticScroll(guard),
    () => 99,
    (clear) => deferred.push(clear),
  );
  assert.equal(guard.target, null, "user input inside a restore must invalidate it");

  assert.equal(shouldTrackTerminalWheel("alternate"), false);
  assert.equal(shouldTrackTerminalWheel("normal"), true);
  assert.equal(isTerminalViewportNavigationKey("alternate", "PageUp", true), false);
  assert.equal(isTerminalViewportNavigationKey("normal", "ArrowUp", false), false);
  assert.equal(isTerminalViewportNavigationKey("normal", "PageUp", false), false);
  assert.equal(isTerminalViewportNavigationKey("normal", "PageUp", true), true);

  assert.doesNotMatch(
    terminalPane,
    /performance\.now\(\)[\s\S]*followBottomRepair/,
    "follow repair must be bounded by frames, not an extendable time window",
  );
  assert.match(terminalPane, /remainingFrames/);
  assert.match(terminalPane, /if \(rehydratingRef\.current\) \{[\s\S]*retryFrames = 0/);
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

test("workspace switching preserves pane selection and focus for agents and plain PowerShell", async () => {
  const { useTerminalStore } = await import("../src/stores/terminalStore.ts");
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
    activeTerminalByWorkspace: {},
    focusedTerminalByWorkspace: {},
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

test("terminal title stays aligned with the durable Jarvis-facing configuration", () => {
  const renameStart = terminalPane.indexOf("const handleRenameSubmit");
  const renameEnd = terminalPane.indexOf("const handleRenameKeyDown", renameStart);
  const renameFlow = terminalPane.slice(renameStart, renameEnd);
  assert.ok(renameStart >= 0 && renameEnd > renameStart);
  assert.ok(
    renameFlow.indexOf('invoke("update_terminal_title"') <
      renameFlow.indexOf("renameTerminal(terminalId, trimmed)"),
  );
  assert.match(renameFlow, /terminal-title-error/);
  assert.doesNotMatch(renameFlow, /catch\(\(\) => undefined\)/);
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
      control.indexOf(".append_terminal_and_save(&workspace.id"),
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
