/**
 * Shared Tauri event bus for terminal output/exit.
 *
 * One global listen("terminal-output") / listen("terminal-exited") fans out
 * only to handlers for the matching terminalId. Output is coalesced per
 * terminal with requestAnimationFrame so bursty PTY streams produce at most
 * one xterm write per frame.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentTurnCompleted,
  TerminalExited,
  TerminalOutput,
} from "../components/terminal/types";

type OutputHandler = (payload: TerminalOutput) => void;
type ExitHandler = (payload: TerminalExited) => void;
type AgentCompletionHandler = (payload: AgentTurnCompleted) => void;

const outputHandlers = new Map<string, Set<OutputHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();
const agentCompletionHandlers = new Set<AgentCompletionHandler>();

/** Pending raw chunks waiting for the next animation frame flush. */
interface PendingOutputChunk {
  sequence: number;
  data: Uint8Array;
}

const pendingChunks = new Map<string, PendingOutputChunk[]>();
const flushScheduled = new Map<string, boolean>();
const MAX_OUTPUT_BYTES_PER_FRAME = 32 * 1024;

let outputUnlisten: UnlistenFn | null = null;
let exitUnlisten: UnlistenFn | null = null;
let outputSetup: Promise<void> | null = null;
let exitSetup: Promise<void> | null = null;
let agentCompletionUnlisten: UnlistenFn | null = null;
let agentCompletionSetup: Promise<void> | null = null;

function mergeChunks(chunks: PendingOutputChunk[]): number[] {
  let total = 0;
  for (const c of chunks) total += c.data.length;
  // Build number[] once for TerminalOutput / xterm write path.
  const out = new Array<number>(total);
  let offset = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.data.length; i++) {
      out[offset++] = c.data[i];
    }
  }
  return out;
}

function flushOutput(terminalId: string) {
  flushScheduled.set(terminalId, false);
  const chunks = pendingChunks.get(terminalId);
  if (!chunks || chunks.length === 0) return;

  // Keep each animation frame responsive when several PTYs stream at once.
  // Consume whole chunks in order; never discard or reorder ANSI bytes.
  let batchBytes = 0;
  let batchEnd = 0;
  while (batchEnd < chunks.length) {
    const nextSize = chunks[batchEnd].data.length;
    if (batchEnd > 0 && batchBytes + nextSize > MAX_OUTPUT_BYTES_PER_FRAME) {
      break;
    }
    batchBytes += nextSize;
    batchEnd++;
  }
  const batch = chunks.splice(0, batchEnd);

  const handlers = outputHandlers.get(terminalId);
  if (handlers && handlers.size > 0) {
    // Single chunk fast-path avoids an extra merge allocation.
    const data =
      batch.length === 1
        ? Array.from(batch[0].data)
        : mergeChunks(batch);
    const payload: TerminalOutput = {
      terminalId,
      data,
      sequence: batch[batch.length - 1].sequence,
      chunks: batch,
    };
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error("terminal-output handler error:", err);
      }
    }
  }

  if (chunks.length > 0 && !flushScheduled.get(terminalId)) {
    flushScheduled.set(terminalId, true);
    requestAnimationFrame(() => flushOutput(terminalId));
  }
}

function enqueueOutput(
  terminalId: string,
  data: number[] | Uint8Array,
  sequence: number,
) {
  // No subscribers (e.g. mid-remount): drop — rehydrate will restore from backend.
  if (!outputHandlers.has(terminalId)) return;

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return;

  let list = pendingChunks.get(terminalId);
  if (!list) {
    list = [];
    pendingChunks.set(terminalId, list);
  }
  list.push({ sequence, data: bytes });

  // PTY output is an unframed ANSI byte stream. Never drop an old chunk here:
  // it can contain half of an escape sequence or an incremental TUI repaint.
  // Losing it leaves diff-based TUIs such as Cline permanently corrupted.

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
    const { terminalId, data, sequence } = event.payload;
    if (!outputHandlers.has(terminalId)) return;
    enqueueOutput(terminalId, data, sequence);
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

async function ensureAgentCompletionListener() {
  if (agentCompletionUnlisten) return;
  if (agentCompletionSetup) {
    await agentCompletionSetup;
    return;
  }

  agentCompletionSetup = listen<AgentTurnCompleted>(
    "agent-turn-completed",
    (event) => {
      console.info("[agent-notification] received from Space", {
        provider: event.payload.provider,
        terminalId: event.payload.terminalId,
        eventId: event.payload.eventId ?? "-",
      });
      for (const handler of agentCompletionHandlers) {
        try {
          handler(event.payload);
        } catch (err) {
          console.error("agent-turn-completed handler error:", err);
        }
      }
    },
  )
    .then((unlisten) => {
      agentCompletionUnlisten = unlisten;
    })
    .catch((err) => {
      console.error("Failed to subscribe agent-turn-completed:", err);
    })
    .finally(() => {
      agentCompletionSetup = null;
    });
  await agentCompletionSetup;
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

/** Subscribe to normalized completion events from agent hooks/plugins. */
export function subscribeAgentTurnCompleted(
  handler: AgentCompletionHandler,
): () => void {
  agentCompletionHandlers.add(handler);
  void ensureAgentCompletionListener();

  return () => {
    agentCompletionHandlers.delete(handler);
  };
}
