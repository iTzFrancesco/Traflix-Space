import assert from "node:assert/strict";
import test from "node:test";
import {
  source,
  terminalPane,
  terminalEvents,
  terminalManager,
  terminalSession,
  outputChunk,
} from "./shared.mjs";
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
  } = await import("../../src/lib/terminalOutputQueue.ts");
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
  } = await import("../../src/lib/terminalWriteBackpressure.ts");
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
  const { isStableTerminalLayout } = await import("../../src/lib/terminalPolicies.ts");

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
  const backendSession = terminalSession;
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
  const session = terminalSession;
  const manager = terminalManager;
  const commands = source("../../src-tauri/src/terminal_engine/commands.rs");
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
