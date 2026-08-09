export const MAX_PENDING_XTERM_BYTES = 4 * 1024 * 1024;

export interface TerminalWriteBackpressure {
  pendingBytes: number;
  pendingWrites: number;
  cancelled: boolean;
  drainWaiters: Set<() => void>;
}

export function createTerminalWriteBackpressure(): TerminalWriteBackpressure {
  return {
    pendingBytes: 0,
    pendingWrites: 0,
    cancelled: false,
    drainWaiters: new Set(),
  };
}

/** Reserve bounded space in xterm's asynchronous parser queue. */
export function reserveTerminalWrite(
  state: TerminalWriteBackpressure,
  byteLength: number,
): boolean {
  if (
    state.cancelled ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    state.pendingBytes + byteLength > MAX_PENDING_XTERM_BYTES
  ) return false;
  state.pendingBytes += byteLength;
  state.pendingWrites += 1;
  return true;
}

/** Release exactly one accepted write when xterm calls its parse callback. */
export function releaseTerminalWrite(
  state: TerminalWriteBackpressure,
  byteLength: number,
): void {
  if (state.pendingWrites > 0) state.pendingWrites -= 1;
  state.pendingBytes = Math.max(0, state.pendingBytes - Math.max(0, byteLength));
  if (state.pendingWrites !== 0) return;
  state.pendingBytes = 0;
  const waiters = [...state.drainWaiters];
  state.drainWaiters.clear();
  for (const resolve of waiters) resolve();
}

/** Snapshot reset must wait until every previously accepted live write parsed. */
export function waitForTerminalWrites(
  state: TerminalWriteBackpressure,
): Promise<void> {
  if (state.cancelled || state.pendingWrites === 0) return Promise.resolve();
  return new Promise((resolve) => state.drainWaiters.add(resolve));
}

/** Resolve detached snapshot tasks before disposing their xterm instance. */
export function cancelTerminalWrites(state: TerminalWriteBackpressure): void {
  state.cancelled = true;
  state.pendingBytes = 0;
  state.pendingWrites = 0;
  const waiters = [...state.drainWaiters];
  state.drainWaiters.clear();
  for (const resolve of waiters) resolve();
}
