export interface TerminalScrollPosition {
  followsOutput: boolean;
  /** Number of buffer rows between the viewport and the live bottom. */
  offsetFromBottom: number;
  /** baseY observed with this intent; used to account for output while unmounted. */
  baseYAtCapture?: number;
}

export interface TerminalScrollSample {
  baseY: number;
  viewportY: number;
  layoutStable: boolean;
  fitInProgress: boolean;
  /** Snapshot/history/replay is still mutating the xterm buffer. */
  rehydrating: boolean;
  userInitiated: boolean;
  programmatic: boolean;
}

export interface ProgrammaticScrollGuard {
  epoch: number;
  target: number | null;
}

export interface ReconciledScrollSample {
  position: TerminalScrollPosition;
  captured: boolean;
  repairFollow: boolean;
}

export function positionFromViewport(
  baseY: number,
  viewportY: number,
): TerminalScrollPosition {
  const offsetFromBottom = Math.max(0, baseY - viewportY);
  if (offsetFromBottom === 0) {
    return { followsOutput: true, offsetFromBottom: 0 };
  }
  return { followsOutput: false, offsetFromBottom, baseYAtCapture: baseY };
}

export function viewportForPosition(
  baseY: number,
  position: TerminalScrollPosition,
): number {
  if (position.followsOutput) return Math.max(0, baseY);
  return Math.max(0, baseY - Math.max(0, position.offsetFromBottom));
}

/** Preserve the same history line while output arrives in a hidden pane. */
export function positionAfterHiddenOutput(
  previous: TerminalScrollPosition,
  baseYBeforeWrite: number,
  baseYAfterWrite: number,
): TerminalScrollPosition {
  if (previous.followsOutput) return previous;
  const addedRows = Math.max(0, baseYAfterWrite - baseYBeforeWrite);
  if (addedRows === 0) return previous;
  return {
    followsOutput: false,
    offsetFromBottom: previous.offsetFromBottom + addedRows,
    baseYAtCapture: baseYAfterWrite,
  };
}

/**
 * Preserve the same viewport row when output arrived while React had no pane
 * (and therefore no output subscriber). No terminal content is retained.
 */
export function positionAfterUnmountedOutput(
  previous: TerminalScrollPosition,
  currentBaseY: number,
): TerminalScrollPosition {
  if (previous.followsOutput) return previous;
  const addedRows = previous.baseYAtCapture === undefined
    ? 0
    : Math.max(0, currentBaseY - previous.baseYAtCapture);
  return {
    followsOutput: false,
    offsetFromBottom: Math.min(
      Math.max(0, currentBaseY),
      previous.offsetFromBottom + addedRows,
    ),
    baseYAtCapture: Math.max(0, currentBaseY),
  };
}

/** Pure policy used by deterministic blur/fit/remount scroll regressions. */
export function reconcileScrollSample(
  previous: TerminalScrollPosition,
  sample: TerminalScrollSample,
): ReconciledScrollSample {
  if (
    !sample.layoutStable ||
    sample.fitInProgress ||
    sample.rehydrating ||
    sample.programmatic
  ) {
    return { position: previous, captured: false, repairFollow: false };
  }
  if (
    !sample.userInitiated &&
    previous.followsOutput &&
    sample.viewportY !== sample.baseY
  ) {
    return { position: previous, captured: false, repairFollow: true };
  }
  return {
    position: positionFromViewport(sample.baseY, sample.viewportY),
    captured: true,
    repairFollow: false,
  };
}

/**
 * Mark only the synchronous xterm scroll caused by one explicit restore as
 * programmatic. A stale marker must not suppress later output/user scrolls.
 * The scheduler is injectable so this lifetime is deterministic in tests.
 */
export function runProgrammaticScroll(
  guard: ProgrammaticScrollGuard,
  scroll: () => void,
  readViewportY: () => number,
  scheduleClear: (clear: () => void) => void = queueMicrotask,
): void {
  const epoch = guard.epoch + 1;
  guard.epoch = epoch;
  guard.target = -1;
  scroll();
  if (guard.epoch !== epoch) return;
  guard.target = readViewportY();
  scheduleClear(() => {
    if (guard.epoch === epoch) guard.target = null;
  });
}

/** User navigation invalidates even a restore currently on the call stack. */
export function cancelProgrammaticScroll(guard: ProgrammaticScrollGuard): void {
  guard.epoch += 1;
  guard.target = null;
}

export function shouldTrackTerminalWheel(bufferType: string): boolean {
  return bufferType === "normal";
}

/** Only modified navigation keys scroll xterm history; arrows belong to the shell/TUI. */
export function isTerminalViewportNavigationKey(
  bufferType: string,
  key: string,
  shiftKey: boolean,
): boolean {
  return bufferType === "normal" &&
    shiftKey &&
    ["PageUp", "PageDown", "Home", "End"].includes(key);
}
