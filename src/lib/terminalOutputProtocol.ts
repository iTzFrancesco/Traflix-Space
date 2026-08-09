export interface TerminalRuntimeKey {
  workspaceId: string;
  generation: number;
  processId: number | null;
}

export interface SequencedTerminalChunk extends TerminalRuntimeKey {
  sequence: number;
  data: Uint8Array;
}

export interface OutputIngestResult {
  deliver: SequencedTerminalChunk[];
  buffered: boolean;
  resyncRequired: boolean;
  ignored: number;
}

export type ReplayResult =
  | { kind: "chunks"; chunks: SequencedTerminalChunk[] }
  | { kind: "empty" }
  | { kind: "gap"; expected: number; received: number };

const MAX_PENDING_CHUNKS = 4096;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

function sameRuntime(left: TerminalRuntimeKey, right: TerminalRuntimeKey): boolean {
  return left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.processId === right.processId;
}

/**
 * Deterministic snapshot-to-live cutover for one terminal pane.
 *
 * The backend snapshot owns every chunk through its watermark. Later chunks are
 * buffered by sequence while xterm is reset. `cutoverToLive` changes phase only
 * when that buffer is empty, in the same JavaScript turn, so an event can never
 * be appended between an "empty" check and the phase transition.
 */
export class TerminalOutputProtocol {
  private runtime: TerminalRuntimeKey | null = null;
  private phase: "buffering" | "live" = "buffering";
  private snapshotWatermark: number | null = null;
  private deliveredSequence = 0;
  private readonly pending = new Map<number, SequencedTerminalChunk>();
  private pendingBytes = 0;

  startRehydrate(runtime: TerminalRuntimeKey): void {
    if (!this.runtime || !sameRuntime(this.runtime, runtime)) {
      this.pending.clear();
      this.pendingBytes = 0;
      this.deliveredSequence = 0;
    }
    this.runtime = { ...runtime };
    this.phase = "buffering";
    this.snapshotWatermark = null;
  }

  installSnapshot(runtime: TerminalRuntimeKey, watermark: number): void {
    if (!this.runtime || !sameRuntime(this.runtime, runtime)) {
      throw new Error("stale-terminal-runtime: snapshot identity changed");
    }
    if (!Number.isSafeInteger(watermark) || watermark < 0) {
      throw new Error("invalid-terminal-watermark");
    }

    this.snapshotWatermark = watermark;
    this.deliveredSequence = watermark;
    for (const sequence of this.pending.keys()) {
      if (sequence <= watermark) {
        this.pendingBytes -= this.pending.get(sequence)?.data.byteLength ?? 0;
        this.pending.delete(sequence);
      }
    }
  }

  ingest(chunks: readonly SequencedTerminalChunk[]): OutputIngestResult {
    if (!this.runtime || chunks.length === 0) {
      return {
        deliver: [],
        buffered: this.phase === "buffering",
        resyncRequired: false,
        ignored: chunks.length,
      };
    }

    const current: SequencedTerminalChunk[] = [];
    const acceptedSequences = new Set<number>();
    let ignored = 0;
    for (const chunk of chunks) {
      if (!sameRuntime(this.runtime, chunk)) {
        ignored += 1;
        continue;
      }
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence <= 0) {
        ignored += 1;
        continue;
      }
      if (
        chunk.sequence <= this.deliveredSequence ||
        this.pending.has(chunk.sequence) ||
        acceptedSequences.has(chunk.sequence)
      ) {
        ignored += 1;
        continue;
      }
      acceptedSequences.add(chunk.sequence);
      current.push(chunk);
    }

    if (this.phase === "buffering") {
      for (const chunk of current) {
        this.pending.set(chunk.sequence, chunk);
        this.pendingBytes += chunk.data.byteLength;
      }
      if (
        this.pending.size > MAX_PENDING_CHUNKS ||
        this.pendingBytes > MAX_PENDING_BYTES
      ) {
        // A failed/remounted pane must not retain an unbounded TUI stream.
        // The backend parser is authoritative, so clear the transient queue
        // and force a new snapshot watermark before any more bytes are shown.
        this.pending.clear();
        this.pendingBytes = 0;
        this.snapshotWatermark = null;
        return {
          deliver: [],
          buffered: true,
          resyncRequired: true,
          ignored,
        };
      }
      return {
        deliver: [],
        buffered: true,
        resyncRequired: false,
        ignored,
      };
    }

    let expected = this.deliveredSequence + 1;
    for (const chunk of current) {
      if (chunk.sequence !== expected) {
        // Preserve the whole batch for the next authoritative snapshot. Writing
        // even a valid prefix can leave xterm in half an ANSI escape sequence.
        this.phase = "buffering";
        this.snapshotWatermark = null;
        for (const candidate of current) {
          this.pending.set(candidate.sequence, candidate);
          this.pendingBytes += candidate.data.byteLength;
        }
        if (
          this.pending.size > MAX_PENDING_CHUNKS ||
          this.pendingBytes > MAX_PENDING_BYTES
        ) {
          this.pending.clear();
          this.pendingBytes = 0;
        }
        return {
          deliver: [],
          buffered: true,
          resyncRequired: true,
          ignored,
        };
      }
      expected += 1;
    }

    if (current.length > 0) {
      this.deliveredSequence = current[current.length - 1].sequence;
    }
    return {
      deliver: current,
      buffered: false,
      resyncRequired: false,
      ignored,
    };
  }

  takeReplay(): ReplayResult {
    if (this.snapshotWatermark === null) {
      throw new Error("terminal snapshot watermark is not installed");
    }
    if (this.pending.size === 0) return { kind: "empty" };

    const ordered = [...this.pending.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    let expected = this.deliveredSequence + 1;
    for (const chunk of ordered) {
      if (chunk.sequence !== expected) {
        return { kind: "gap", expected, received: chunk.sequence };
      }
      expected += 1;
    }

    this.pending.clear();
    this.pendingBytes = 0;
    this.deliveredSequence = ordered[ordered.length - 1].sequence;
    return { kind: "chunks", chunks: ordered };
  }

  /**
   * Atomically enter live mode only if no callback appended another chunk.
   * The caller retries replay when this returns false.
   */
  cutoverToLive(): boolean {
    if (this.snapshotWatermark === null || this.pending.size > 0) return false;
    this.phase = "live";
    return true;
  }

  isBuffering(): boolean {
    return this.phase === "buffering";
  }

  currentRuntime(): TerminalRuntimeKey | null {
    return this.runtime ? { ...this.runtime } : null;
  }

  lastDeliveredSequence(): number {
    return this.deliveredSequence;
  }
}
