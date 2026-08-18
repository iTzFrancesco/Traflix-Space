import assert from "node:assert/strict";
import test from "node:test";
import {
  source,
  terminalManager,
  terminalPane,
  terminalPaneLayout,
  terminalPaneLifecycle,
  terminalPaneRuntime,
  terminalPaneSupport,
  workspaceView,
} from "./shared.mjs";
test("terminal close commits frontend removal only after durable config persistence", () => {
  const manager = terminalManager;
  const commands = source("../../src-tauri/src/terminal_engine/commands.rs");
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
  const workspaceGrid = source("../../src/components/workspace/WorkspaceGrid.tsx");
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
  const resizeFlow = terminalPaneLayout;
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
  const workspaceGrid = source("../../src/components/workspace/WorkspaceGrid.tsx");
  assert.match(workspaceGrid, /computeLayout\(terminals\.length\)/);
  assert.match(workspaceGrid, /layoutRevision/);
  assert.match(workspaceGrid, /sidebarWidth/);
  assert.match(workspaceGrid, /sidebarCollapsed/);
  assert.match(workspaceGrid, /height: "100%"/);
  assert.match(workspaceGrid, /padding: isFocusMode[\s\S]*\? 0/);
  assert.match(workspaceGrid, /: \{ display: "none" \}/);
  assert.doesNotMatch(workspaceGrid, /width: 1,[\s\S]*height: 1/);
  assert.match(source("../../src/App.tsx"), /<main className="min-w-0 flex-1/);
});

test("fullscreen and close transitions cannot retain stale grid tracks or an empty hidden cell", () => {
  const workspaceGrid = source("../../src/components/workspace/WorkspaceGrid.tsx");
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
  const terminalPaneSource = terminalPaneLayout;
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
  const { computeLayout } = await import("../../src/lib/presets.ts");
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
  const cleanupStart = terminalPaneLifecycle.indexOf("disposed = true;");
  const cleanupEnd = terminalPaneLifecycle.indexOf("term.dispose();", cleanupStart);
  assert.ok(cleanupStart >= 0, "terminal cleanup must be present");
  assert.ok(cleanupEnd > cleanupStart, "terminal cleanup must dispose xterm");
  assert.doesNotMatch(
    terminalPaneLifecycle.slice(cleanupStart, cleanupEnd),
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
  } = await import("../../src/lib/terminalScrollState.ts");

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
  } = await import("../../src/lib/terminalScrollState.ts");

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
    terminalPaneRuntime + terminalPaneLifecycle,
    /performance\.now\(\)[\s\S]*followBottomRepair/,
    "follow repair must be bounded by frames, not an extendable time window",
  );
  assert.match(terminalPane, /remainingFrames/);
  assert.match(terminalPane, /if \(rehydratingRef\.current\) \{[\s\S]*retryFrames = 0/);
});
