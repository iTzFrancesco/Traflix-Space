export interface TerminalScrollPosition {
  followsOutput: boolean;
  /** Number of buffer rows between the viewport and the live bottom. */
  offsetFromBottom: number;
}

export interface TerminalScrollSample {
  baseY: number;
  viewportY: number;
  layoutStable: boolean;
  fitInProgress: boolean;
  userInitiated: boolean;
  programmatic: boolean;
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
  return {
    followsOutput: offsetFromBottom === 0,
    offsetFromBottom,
  };
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
  };
}

/** Pure policy used by deterministic blur/fit/remount scroll regressions. */
export function reconcileScrollSample(
  previous: TerminalScrollPosition,
  sample: TerminalScrollSample,
): ReconciledScrollSample {
  if (!sample.layoutStable || sample.fitInProgress || sample.programmatic) {
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
