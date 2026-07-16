/**
 * Shared Tauri event bus for terminal output/exit.
 *
 * One global listen("terminal-output") / listen("terminal-exited") fans out
 * only to handlers for the matching terminalId. Output is coalesced per
 * terminal with requestAnimationFrame so bursty PTY streams produce at most
 * one xterm write per frame.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalExited, TerminalOutput } from "../components/terminal/types";

type OutputHandler = (payload: TerminalOutput) => void;
type ExitHandler = (payload: TerminalExited) => void;

const outputHandlers = new Map<string, Set<OutputHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();

/** Pending raw chunks waiting for the next animation frame flush. */
const pendingChunks = new Map<string, Uint8Array[]>();
const flushScheduled = new Map<string, boolean>();

let outputUnlisten: UnlistenFn | null = null;
let exitUnlisten: UnlistenFn | null = null;
let outputSetup: Promise<void> | null = null;
let exitSetup: Promise<void> | null = null;

function mergeChunks(chunks: Uint8Array[]): number[] {
  let total = 0;
  for (const c of chunks) total += c.length;
  // Build number[] once for TerminalOutput / xterm write path.
  const out = new Array<number>(total);
  let offset = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      out[offset++] = c[i];
    }
  }
  return out;
}

function flushOutput(terminalId: string) {
  flushScheduled.set(terminalId, false);
  const chunks = pendingChunks.get(terminalId);
  if (!chunks || chunks.length === 0) return;
  pendingChunks.set(terminalId, []);

  const handlers = outputHandlers.get(terminalId);
  if (!handlers || handlers.size === 0) return;

  // Single chunk fast-path avoids an extra merge allocation.
  const data =
    chunks.length === 1
      ? Array.from(chunks[0])
      : mergeChunks(chunks);
  const payload: TerminalOutput = { terminalId, data };
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      console.error("terminal-output handler error:", err);
    }
  }
}

function enqueueOutput(terminalId: string, data: number[] | Uint8Array) {
  // No subscribers (e.g. mid-remount): drop — rehydrate will restore from backend.
  if (!outputHandlers.has(terminalId)) return;

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return;

  let list = pendingChunks.get(terminalId);
  if (!list) {
    list = [];
    pendingChunks.set(terminalId, list);
  }
  list.push(bytes);

  // Cap pending burst per terminal (~256KB) to avoid unbounded RAM if the
  // renderer stalls under heavy multi-pane output.
  let pendingBytes = 0;
  for (const c of list) pendingBytes += c.length;
  while (pendingBytes > 262_144 && list.length > 1) {
    const dropped = list.shift()!;
    pendingBytes -= dropped.length;
  }

  if (!flushScheduled.get(terminalId)) {
    flushScheduled.set(terminalId, true);
    requestAnimationFrame(() => flushOutput(terminalId));
  }
}

async function ensureOutputListener() {
  if (outputUnlisten) return;
  if (outputSetup) {
    await outputSetup;
    return;
  }
  outputSetup = listen<TerminalOutput>("terminal-output", (event) => {
    const { terminalId, data } = event.payload;
    if (!outputHandlers.has(terminalId)) return;
    enqueueOutput(terminalId, data);
  })
    .then((unlisten) => {
      outputUnlisten = unlisten;
    })
    .catch((err) => {
      console.error("Failed to subscribe terminal-output:", err);
    })
    .finally(() => {
      outputSetup = null;
    });
  await outputSetup;
}

async function ensureExitListener() {
  if (exitUnlisten) return;
  if (exitSetup) {
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
  })
    .then((unlisten) => {
      exitUnlisten = unlisten;
    })
    .catch((err) => {
      console.error("Failed to subscribe terminal-exited:", err);
    })
    .finally(() => {
      exitSetup = null;
    });
  await exitSetup;
}

/** Subscribe to batched output for a single terminal. Returns unsubscribe fn. */
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
      pendingChunks.delete(terminalId);
      flushScheduled.delete(terminalId);
      // Keep the global Tauri listen alive for the app lifetime — teardown
      // races under rapid remount are more expensive than one idle listener.
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
    }
  };
}
