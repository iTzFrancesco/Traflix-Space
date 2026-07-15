/**
 * Shared Tauri event bus for terminal output/exit.
 *
 * Without this, each TerminalPane registers its own listen("terminal-output")
 * and listen("terminal-exited"), so N open panes = 2N global listeners that
 * all receive every event. A single subscription fans out only to the
 * matching terminalId handlers.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalExited, TerminalOutput } from "../components/terminal/types";

type OutputHandler = (payload: TerminalOutput) => void;
type ExitHandler = (payload: TerminalExited) => void;

const outputHandlers = new Map<string, Set<OutputHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();

let outputUnlisten: UnlistenFn | null = null;
let exitUnlisten: UnlistenFn | null = null;
let outputSetup: Promise<void> | null = null;
let exitSetup: Promise<void> | null = null;

async function ensureOutputListener() {
  if (outputUnlisten || outputSetup) {
    await outputSetup;
    return;
  }
  outputSetup = listen<TerminalOutput>("terminal-output", (event) => {
    const handlers = outputHandlers.get(event.payload.terminalId);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(event.payload);
      } catch (err) {
        console.error("terminal-output handler error:", err);
      }
    }
  }).then((unlisten) => {
    outputUnlisten = unlisten;
  }).catch((err) => {
    console.error("Failed to subscribe terminal-output:", err);
  }).finally(() => {
    outputSetup = null;
  });
  await outputSetup;
}

async function ensureExitListener() {
  if (exitUnlisten || exitSetup) {
    await exitSetup;
    return;
  }
  exitSetup = listen<TerminalExited>("terminal-exited", (event) => {
    const handlers = exitHandlers.get(event.payload.terminalId);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(event.payload);
      } catch (err) {
        console.error("terminal-exited handler error:", err);
      }
    }
  }).then((unlisten) => {
    exitUnlisten = unlisten;
  }).catch((err) => {
    console.error("Failed to subscribe terminal-exited:", err);
  }).finally(() => {
    exitSetup = null;
  });
  await exitSetup;
}

function maybeTeardownOutput() {
  if (outputHandlers.size === 0 && outputUnlisten) {
    outputUnlisten();
    outputUnlisten = null;
  }
}

function maybeTeardownExit() {
  if (exitHandlers.size === 0 && exitUnlisten) {
    exitUnlisten();
    exitUnlisten = null;
  }
}

/** Subscribe to output for a single terminal. Returns unsubscribe fn. */
export function subscribeTerminalOutput(
  terminalId: string,
  handler: OutputHandler,
): () => void {
  let set = outputHandlers.get(terminalId);
  if (!set) {
    set = new Set();
    outputHandlers.set(terminalId, set);
  }
  set.add(handler);
  void ensureOutputListener();

  return () => {
    const current = outputHandlers.get(terminalId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      outputHandlers.delete(terminalId);
      maybeTeardownOutput();
    }
  };
}

/** Subscribe to exit for a single terminal. Returns unsubscribe fn. */
export function subscribeTerminalExit(
  terminalId: string,
  handler: ExitHandler,
): () => void {
  let set = exitHandlers.get(terminalId);
  if (!set) {
    set = new Set();
    exitHandlers.set(terminalId, set);
  }
  set.add(handler);
  void ensureExitListener();

  return () => {
    const current = exitHandlers.get(terminalId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      exitHandlers.delete(terminalId);
      maybeTeardownExit();
    }
  };
}
