import type { MutableRefObject } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import { isStableTerminalLayout } from "../../lib/terminalPolicies";
import {
  cancelProgrammaticScroll,
  positionFromViewport,
  runProgrammaticScroll,
  type ProgrammaticScrollGuard,
  viewportForPosition,
} from "../../lib/terminalScrollState";
import type { TerminalScrollPosition } from "../../stores/terminalStore";
import type { SequencedTerminalChunk, TerminalRuntimeKey } from "../../lib/terminalOutputProtocol";
import { invokeWithTimeout } from "../../lib/timeout";
import { useTerminalStore } from "../../stores/terminalStore";

export function captureScrollPosition(
  term: Terminal,
  autoScrollRef: MutableRefObject<boolean>,
  scrollPositionRef: MutableRefObject<TerminalScrollPosition>,
) {
  const buffer = term.buffer.active;
  const position = positionFromViewport(buffer.baseY, buffer.viewportY);
  autoScrollRef.current = position.followsOutput;
  scrollPositionRef.current = position;
}

export interface TerminalPaneVisibility {
  focusModeActive: boolean;
  isFocused: boolean;
}

/**
 * xterm can report viewportY=0 while its host window/pane is hidden or being
 * collapsed by the focus grid. Those events are layout noise, not user
 * navigation, and must never overwrite the saved follow/history intent.
 */
export function isTerminalScrollLayoutUsable(
  term: Terminal,
  paneVisibilityRef: MutableRefObject<TerminalPaneVisibility>,
  windowFocusedRef: MutableRefObject<boolean>,
): boolean {
  if (
    paneVisibilityRef.current.focusModeActive &&
    !paneVisibilityRef.current.isFocused
  ) {
    return false;
  }
  if (!windowFocusedRef.current || document.visibilityState === "hidden") {
    return false;
  }

  const element = term.element;
  if (!element?.isConnected || element.offsetParent === null) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

interface TerminalViewportAnchor {
  approximateY: number;
  lineOffset: number;
  text: string;
}

/** Capture readable content so a column/row reflow can find the same line. */
function captureViewportAnchor(term: Terminal): TerminalViewportAnchor | null {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal" || buffer.baseY === 0) return null;

  const maxOffset = Math.min(term.rows, buffer.length - buffer.viewportY);
  for (let lineOffset = 0; lineOffset < maxOffset; lineOffset += 1) {
    const text = buffer
      .getLine(buffer.viewportY + lineOffset)
      ?.translateToString(true)
      .trim();
    if (text && text.length >= 4) {
      return {
        approximateY: buffer.viewportY,
        lineOffset,
        // Keep matching cheap while retaining enough context to avoid most
        // duplicate prompt/blank-line matches.
        text: text.slice(0, 160),
      };
    }
  }
  return null;
}

/** Restore an anchor after xterm has reflowed its buffer. */
function restoreViewportAnchor(
  term: Terminal,
  anchor: TerminalViewportAnchor | null,
  programmaticScrollGuardRef: MutableRefObject<ProgrammaticScrollGuard>,
): boolean {
  if (!anchor || term.buffer.active.type !== "normal") return false;

  const buffer = term.buffer.active;
  const exactNeedle = anchor.text;
  const partialNeedle = exactNeedle.length >= 12 ? exactNeedle.slice(0, 48) : exactNeedle;
  let match = -1;
  let matchKind = Number.POSITIVE_INFINITY;
  let matchDistance = Number.POSITIVE_INFINITY;

  for (let line = 0; line < buffer.length; line += 1) {
    const text = buffer.getLine(line)?.translateToString(true).trim() ?? "";
    const kind = text === exactNeedle
      ? 0
      : partialNeedle.length >= 4 && text.includes(partialNeedle)
        ? 1
        : Number.POSITIVE_INFINITY;
    if (kind === Number.POSITIVE_INFINITY) continue;
    const distance = Math.abs(line - anchor.approximateY);
    if (kind < matchKind || (kind === matchKind && distance < matchDistance)) {
      match = line;
      matchKind = kind;
      matchDistance = distance;
    }
  }

  if (match < 0) return false;

  const target = Math.max(
    0,
    Math.min(buffer.baseY, match - anchor.lineOffset),
  );
  runProgrammaticScroll(
    programmaticScrollGuardRef.current,
    () => term.scrollToLine(target),
    () => term.buffer.active.viewportY,
  );
  return true;
}

export function restoreScrollPosition(
  term: Terminal,
  autoScrollRef: MutableRefObject<boolean>,
  scrollPositionRef: MutableRefObject<TerminalScrollPosition>,
  programmaticScrollGuardRef: MutableRefObject<ProgrammaticScrollGuard>,
  position: TerminalScrollPosition = scrollPositionRef.current,
) {
  const { followsOutput } = position;
  if (followsOutput) {
    scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
    runProgrammaticScroll(
      programmaticScrollGuardRef.current,
      () => term.scrollToBottom(),
      () => term.buffer.active.viewportY,
    );
    autoScrollRef.current = true;
    return;
  }

  // A remounted pane can be fitted before its backend scrollback finishes
  // rehydrating. There is nothing to restore yet; keep the saved reader intent
  // intact instead of converting it to "follow" at buffer line zero.
  if (term.buffer.active.baseY === 0) {
    scrollPositionRef.current = position;
    autoScrollRef.current = false;
    return;
  }

  // `baseY` changes when xterm reflows during a fit. Restoring a distance from
  // the live bottom keeps the same reading context and, crucially, never turns
  // a layout change into a jump to the first line of the buffer.
  runProgrammaticScroll(
    programmaticScrollGuardRef.current,
    () => term.scrollToLine(viewportForPosition(term.buffer.active.baseY, position)),
    () => term.buffer.active.viewportY,
  );
  captureScrollPosition(term, autoScrollRef, scrollPositionRef);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function isTerminalExitedError(error: unknown): boolean {
  return String(error).toLowerCase().includes("terminal-exited");
}

export function runtimeKey(identity: TerminalRuntimeKey): TerminalRuntimeKey {
  return {
    workspaceId: identity.workspaceId,
    generation: identity.generation,
    processId: identity.processId,
  };
}

export function currentRuntimeKey(terminalId: string): TerminalRuntimeKey | null {
  const terminal = useTerminalStore.getState().terminals[terminalId];
  if (!terminal || terminal.generation === null) return null;
  return {
    workspaceId: terminal.workspaceId,
    generation: terminal.generation,
    processId: terminal.processId,
  };
}

export function sameRuntimeKey(
  left: TerminalRuntimeKey | null,
  right: TerminalRuntimeKey,
): boolean {
  return left !== null &&
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.processId === right.processId;
}

export function mergeOutputChunks(chunks: readonly SequencedTerminalChunk[]): Uint8Array {
  if (chunks.length === 1) return chunks[0].data;
  let total = 0;
  for (const chunk of chunks) total += chunk.data.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return merged;
}

/** Measure the mounted pane before taking a backend snapshot or resizing a PTY. */
export async function syncMeasuredPtySize(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  runtime: TerminalRuntimeKey,
  skipHiddenPane: boolean,
  resizeStateRef: MutableRefObject<PtyResizeState>,
  fitInProgressRef: MutableRefObject<boolean>,
) {
  if (skipHiddenPane) return;

  // The workspace grid has just mounted. Two frames let the grid tracks and
  // the xterm canvas settle before FitAddon reads its cell dimensions.
  await waitForAnimationFrame();
  await waitForAnimationFrame();
  // The DOM box is authoritative even while the window is unfocused: a
  // visible but unfocused window still has real layout dimensions. Only a
  // hidden/minimized document must be skipped (its boxes are degenerate).
  if (document.visibilityState === "hidden") return;
  if (!term.element?.isConnected) return;
  const layoutElement = term.element.parentElement ?? term.element;
  const rect = layoutElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const proposed = fitAddon.proposeDimensions();
  if (
    !proposed ||
    !isStableTerminalLayout({
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  ) {
    // A transient measurement must not resize a live PTY to an arbitrary
    // fallback. ResizeObserver/focus will schedule another pass once the real
    // layout is available; that valid pass also repairs an older bad size.
    return;
  }

  try {
    fitInProgressRef.current = true;
    fitAddon.fit();
  } catch {
    return;
  } finally {
    fitInProgressRef.current = false;
  }
  if (
    !isStableTerminalLayout({
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: term.cols,
      rows: term.rows,
    })
  ) {
    return;
  }
  try {
    await enqueuePtyResize(resizeStateRef, terminalId, runtime, term.cols, term.rows);
  } catch (error) {
    if (String(error).includes("stale-terminal-runtime")) return;
    reportFrontendDiagnostic("terminal-resize-error", error, {
      terminalId,
      workspaceId: runtime.workspaceId,
      generation: runtime.generation,
      processId: runtime.processId,
      state: "initial-fit",
    });
    console.warn("[terminal-lifecycle] initial PTY resize rejected", {
      terminalId,
      generation: runtime.generation,
      processId: runtime.processId,
      error: String(error),
    });
  }
}

export function fitAndResizePty(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  runtime: TerminalRuntimeKey | null,
  autoScrollRef: MutableRefObject<boolean>,
  scrollPositionRef: MutableRefObject<TerminalScrollPosition>,
  programmaticScrollGuardRef: MutableRefObject<ProgrammaticScrollGuard>,
  resizeStateRef: MutableRefObject<PtyResizeState>,
  fitInProgressRef: MutableRefObject<boolean>,
): boolean {
  if (runtime === null || document.visibilityState === "hidden") return false;

  const layoutElement = term.element?.parentElement ?? term.element;
  const rect = layoutElement?.getBoundingClientRect();
  const proposed = fitAddon.proposeDimensions();
  if (
    !rect ||
    !proposed ||
    !isStableTerminalLayout({
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  ) {
    return false;
  }

  // The refs are the authoritative viewport intent. xterm can temporarily
  // report y=0 during a hidden-pane/window reflow, so reading its live ydisp
  // here would turn follow mode into a false history position.
  const positionBeforeFit = scrollPositionRef.current;
  const expectedViewport = viewportForPosition(
    term.buffer.active.baseY,
    positionBeforeFit,
  );
  // A pane that has just returned from blur/focus mode can expose a transient
  // viewportY=0 even though its saved reader position is in the middle. Do not
  // turn that layout artifact into a content anchor at the top.
  const transientTop =
    !positionBeforeFit.followsOutput &&
    term.buffer.active.viewportY === 0 &&
    expectedViewport > 0;
  const viewportAnchor = positionBeforeFit.followsOutput || transientTop
    ? null
    : captureViewportAnchor(term);
  try {
    fitInProgressRef.current = true;
    fitAddon.fit();
  } catch {
    // Fit can throw if container has zero size (hidden pane).
    return false;
  } finally {
    fitInProgressRef.current = false;
  }
  if (
    !isStableTerminalLayout({
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: term.cols,
      rows: term.rows,
    })
  ) {
    return false;
  }
  if (positionBeforeFit.followsOutput) {
    // Following the live stream is the one case where an explicit bottom
    // restore is correct. For a reader in history, xterm's buffer reflow
    // already adjusts ydisp to keep the same content visible. Reapplying the
    // old bottom-relative offset after reflow can clamp to line zero when a
    // wider/taller layout reduces baseY.
    restoreScrollPosition(
      term,
      autoScrollRef,
      scrollPositionRef,
      programmaticScrollGuardRef,
      positionBeforeFit,
    );
  } else if (term.buffer.active.baseY > 0) {
    // xterm normally keeps ydisp stable during reflow. If a focus transition
    // changes both columns and rows, however, its row arithmetic can still
    // land at the first line. Restore the visible content anchor in that
    // case, then capture the new bottom-relative position for later remounts.
    const anchorRestored = restoreViewportAnchor(
      term,
      viewportAnchor,
      programmaticScrollGuardRef,
    );
    if (anchorRestored) {
      captureScrollPosition(term, autoScrollRef, scrollPositionRef);
    } else {
      // If reflow removed/truncated the anchor, preserve the last stable
      // bottom-relative intent. Sampling xterm here could persist its transient
      // viewportY=0 and turn a middle position into a jump to the top.
      restoreScrollPosition(
        term,
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollGuardRef,
        positionBeforeFit,
      );
    }
  } else {
    // There is no scrollback yet. Preserve the reader intent until rehydrate
    // or output creates a scrollable buffer.
    scrollPositionRef.current = positionBeforeFit;
    autoScrollRef.current = false;
    cancelProgrammaticScroll(programmaticScrollGuardRef.current);
  }
  if (term.cols > 0 && term.rows > 0) {
    void enqueuePtyResize(
      resizeStateRef,
      terminalId,
      runtime,
      term.cols,
      term.rows,
    ).catch((error) => {
      if (String(error).includes("stale-terminal-runtime")) return;
      reportFrontendDiagnostic("terminal-resize-error", error, {
        terminalId,
        workspaceId: runtime.workspaceId,
        generation: runtime.generation,
        processId: runtime.processId,
        state: "fit-resize",
      });
      console.warn("[terminal-lifecycle] PTY resize rejected", {
        terminalId,
        generation: runtime.generation,
        processId: runtime.processId,
        error: String(error),
      });
    });
  }
  return true;
}

export interface PtyResizeState {
  pending: {
    runtime: TerminalRuntimeKey;
    cols: number;
    rows: number;
    waiters: Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }>;
  } | null;
  flushing: boolean;
}

/** Serialize PTY resizes and keep only the newest pending geometry. */
function enqueuePtyResize(
  stateRef: MutableRefObject<PtyResizeState>,
  terminalId: string,
  runtime: TerminalRuntimeKey,
  cols: number,
  rows: number,
): Promise<void> {
  const state = stateRef.current;
  const promise = new Promise<void>((resolve, reject) => {
    const sameRuntime =
      state.pending?.runtime.workspaceId === runtime.workspaceId &&
      state.pending.runtime.generation === runtime.generation &&
      state.pending.runtime.processId === runtime.processId;
    if (state.pending && !sameRuntime) {
      const staleError = new Error("stale-terminal-runtime: queued resize superseded");
      for (const waiter of state.pending.waiters) waiter.reject(staleError);
    }
    const waiters = sameRuntime ? state.pending?.waiters ?? [] : [];
    state.pending = {
      runtime: { ...runtime },
      cols,
      rows,
      waiters: [...waiters, { resolve, reject }],
    };
  });
  if (state.flushing) return promise;

  state.flushing = true;
  void (async () => {
    try {
      while (state.pending) {
        const next = state.pending;
        state.pending = null;
        try {
          await invokeWithTimeout(
            () => invoke("terminal_resize", {
              terminalId,
              ...next.runtime,
              cols: next.cols,
              rows: next.rows,
            }),
            10000,
          );
          for (const waiter of next.waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of next.waiters) waiter.reject(error);
        }
      }
    } finally {
      state.flushing = false;
    }
  })();
  return promise;
}

