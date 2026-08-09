export interface TerminalResizeProbe {
  documentVisible: boolean;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

// The app's minimum window and grid sizes cannot produce a useful terminal
// with fewer than these cells. Smaller values are the transient dimensions
// reported by WebView2 while the window is being hidden or restored.
export const MIN_USABLE_TERMINAL_COLS = 8;
export const MIN_USABLE_TERMINAL_ROWS = 2;

export function isStableTerminalLayout(probe: TerminalResizeProbe): boolean {
  return (
    probe.documentVisible &&
    Number.isFinite(probe.width) &&
    Number.isFinite(probe.height) &&
    probe.width > 2 &&
    probe.height > 2 &&
    Number.isInteger(probe.cols) &&
    Number.isInteger(probe.rows) &&
    probe.cols >= MIN_USABLE_TERMINAL_COLS &&
    probe.rows >= MIN_USABLE_TERMINAL_ROWS
  );
}
