export const MAX_PENDING_OUTPUT_CHUNKS = 4096;
export const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface TerminalOutputQueueRuntime {
  workspaceId: string;
  generation: number;
  processId: number | null;
  sequence: number;
}

/** Pure capacity policy shared by the event bus and deterministic regressions. */
export function isTerminalOutputQueueOverflow(
  chunkCount: number,
  byteCount: number,
): boolean {
  return chunkCount > MAX_PENDING_OUTPUT_CHUNKS ||
    byteCount > MAX_PENDING_OUTPUT_BYTES;
}

/** Return the last lost sequence for every PTY lifetime represented in a queue. */
export function affectedTerminalOutputRuntimes<T extends TerminalOutputQueueRuntime>(
  chunks: readonly T[],
): TerminalOutputQueueRuntime[] {
  const runtimes = new Map<string, TerminalOutputQueueRuntime>();
  for (const chunk of chunks) {
    const key = JSON.stringify([
      chunk.workspaceId,
      chunk.generation,
      chunk.processId,
    ]);
    runtimes.set(key, {
      workspaceId: chunk.workspaceId,
      generation: chunk.generation,
      processId: chunk.processId,
      sequence: chunk.sequence,
    });
  }
  return [...runtimes.values()];
}
