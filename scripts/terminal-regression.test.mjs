import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const terminalPane = source("../src/components/workspace/TerminalPane.tsx");
const terminalEvents = source("../src/lib/terminalEvents.ts");
const workspaceView = source("../src/components/workspace/WorkspaceView.tsx");

test("terminal output is subscribed and ready before PTY spawn", () => {
  const subscription = terminalPane.indexOf(
    "outputWarmupUnsubRef.current = subscribeTerminalOutput",
  );
  const spawn = terminalPane.indexOf('invoke<number>("terminal_spawn"');
  assert.ok(subscription >= 0, "TerminalPane must subscribe to terminal output");
  assert.ok(spawn >= 0, "TerminalPane must spawn the PTY");
  assert.ok(subscription < spawn, "the first output subscription must precede PTY spawn");
  assert.match(terminalPane, /await waitForTerminalOutputListener\(\)/);
  assert.match(terminalEvents, /export async function waitForTerminalOutputListener/);
  assert.match(terminalEvents, /generation: number/);
  assert.match(terminalPane, /payload\.generation !== terminalGenerationRef\.current/);
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
  const syncStart = terminalPane.indexOf("async function syncMeasuredPtySize");
  const fitStart = terminalPane.indexOf("function fitAndResizePty", syncStart);
  assert.doesNotMatch(
    terminalPane.slice(syncStart, fitStart),
    /enqueuePtyResize\([^)]*fallback/,
    "an unstable measurement must not send a guessed fallback resize",
  );
});

test("PTY generations protect reopen events and manual reopen rehydrates before live output", () => {
  assert.match(terminalEvents, /generation, data, sequence/);
  assert.match(terminalEvents, /Never merge chunks from different PTY lifetimes/);
  assert.match(terminalPane, /const generation = await invoke<number>\("terminal_reopen"/);
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
  assert.match(commands, /pub async fn terminal_reopen[\s\S]*Result<u64, String>/);
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
});
