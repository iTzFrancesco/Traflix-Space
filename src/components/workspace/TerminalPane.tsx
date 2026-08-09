import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, Maximize2, Minimize2, X, GripHorizontal } from "lucide-react";
import { useTerminalInput } from "../terminal/useTerminalInput";
import {
  useTerminalStore,
  type TerminalScrollPosition,
} from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSkillStore } from "../../stores/skillStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import {
  subscribeTerminalExit,
  subscribeTerminalOutput,
  waitForTerminalOutputListener,
} from "../../lib/terminalEvents";
import { encodeForPty } from "../../lib/ptyWrite";
import { getWorkspaceColor } from "../../lib/workspaceColors";
import { AGENTS } from "../../lib/agents";
import { findCurrentPowerShellPrompt } from "../../lib/powerShellPrompt";
import { invokeWithTimeout } from "../../lib/timeout";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import { isStableTerminalLayout } from "../../lib/terminalPolicies";
import {
  positionAfterHiddenOutput,
  positionFromViewport,
  reconcileScrollSample,
  viewportForPosition,
} from "../../lib/terminalScrollState";
import {
  TerminalOutputProtocol,
  type SequencedTerminalChunk,
  type TerminalRuntimeKey,
} from "../../lib/terminalOutputProtocol";
import type {
  TerminalRehydrateState,
  TerminalRuntimeIdentity,
} from "../terminal/types";
import "xterm/css/xterm.css";

/** Map agent id to a short display name for the title bar. */
function agentDisplayName(agentId: string): string {
  const found = AGENTS.find((a) => a.id === agentId);
  return found?.name ?? agentId;
}

/** Extract project/folder name from a CWD path. */
function projectNameFromCwd(cwd: string): string {
  // Normalize backslashes for cross-platform consistency.
  const normalized = cwd.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const STOCK_THEME = {
  background: "#111211", // --canvas
  foreground: "#f5f3ef", // --ink
  cursor: "#ff9d24", // --accent
  cursorAccent: "#111211",
  selectionBackground: "rgba(255, 157, 36, 0.25)",
  selectionInactiveBackground: "rgba(255, 157, 36, 0.12)",
  black: "#111211",
  red: "#ff626b", // --danger
  green: "#55d89b", // --signal
  yellow: "#ffae42", // --primary-light
  blue: "#ff9d24",
  magenta: "#ff6b21",
  cyan: "#29b8db",
  white: "#f5f3ef",
  brightBlack: "#74716c",
  brightRed: "#ff626b",
  brightGreen: "#55d89b",
  brightYellow: "#ffae42",
  brightBlue: "#ff9d24",
  brightMagenta: "#ff6b21",
  brightCyan: "#29b8db",
  brightWhite: "#f5f3ef",
};

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  /** Number of panes in this workspace; drives the title-bar density. */
  terminalCount: number;
  isActive: boolean;
  /** This pane is the focus-mode target. */
  isFocused?: boolean;
  /** Any pane is currently in focus mode (grid collapsed). */
  focusModeActive?: boolean;
  /** Monotonic token used to request the close confirmation from a shortcut. */
  closeRequestToken?: number;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
  onToggleFocus?: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
}

// Layout definitions for each terminal pane. The terminal pane consists of title
// bar (above) and xterm container (below) stack vertically.
const ACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-primary)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "0 4px 20px rgba(255, 157, 36, 0.04)",
};

const FOCUSED_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-primary-strong)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "0 4px 20px rgba(255, 107, 33, 0.05)",
};

const INACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-neutral-border)",
  overflow: "hidden",
  cursor: "pointer",
  isolation: "isolate",
};

const EXITED_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(255, 98, 107, 0.25)",
  overflow: "hidden",
  isolation: "isolate",
};

const CONTAINER_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  overflow: "hidden",
};

const TITLE_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255, 255, 255, 0.015)",
  borderBottom: "1px solid var(--color-neutral-border)",
  userSelect: "none",
  overflow: "hidden",
};

function getTitleBarMetrics(terminalCount: number) {
  if (terminalCount <= 1) {
    return { height: 42, padding: "0 14px", fontSize: 13, buttonSize: 32, iconSize: 16, dotSize: 10 };
  }
  if (terminalCount === 2) {
    return { height: 40, padding: "0 12px", fontSize: 12, buttonSize: 32, iconSize: 15, dotSize: 9 };
  }
  if (terminalCount <= 4) {
    return { height: 38, padding: "0 10px", fontSize: 12, buttonSize: 32, iconSize: 14, dotSize: 8 };
  }
  return { height: 36, padding: "0 9px", fontSize: 12, buttonSize: 30, iconSize: 14, dotSize: 7 };
}

/** Return the latest complete PowerShell prompt, including wrapped paths. */
function powerShellPrompt(term: Terminal) {
  const buffer = term.buffer.active;
  const lastLine = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
  let firstLine = Math.max(0, lastLine - 16);
  while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) {
    firstLine--;
  }

  const lines = [];
  for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
    const line = buffer.getLine(lineIndex);
    if (!line) continue;
    const nextLine = buffer.getLine(lineIndex + 1);
    lines.push({
      // A wrapped continuation means this row was completely filled. Keeping
      // its trailing spaces preserves valid paths split exactly on a space.
      text: line.translateToString(!nextLine?.isWrapped),
      isWrapped: line.isWrapped,
    });
  }
  return findCurrentPowerShellPrompt(lines);
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/^\\\\[?.]\\/, "").replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function isPowerShell(shell: string): boolean {
  const executable = shell.replace(/\\/g, "/").split("/").pop() ?? shell;
  return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(executable);
}

interface TerminalContext {
  cwd: string;
  gitBranch: string | null;
}

interface TerminalCwdChangedPayload {
  terminalId: string;
  workspaceId: string;
  generation: number;
  processId: number | null;
  cwd: string;
}

const TITLE_BAR_LEFT: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  minWidth: 0,
  flex: 1,
};

const TITLE_BAR_DOT: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const TITLE_BAR_NAME: React.CSSProperties = {
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: "rgba(255,255,255,0.8)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "text",
  lineHeight: 1,
  minWidth: 0,
  letterSpacing: "0.02em",
};

const TITLE_BAR_RENAME_INPUT: React.CSSProperties = {
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: "rgba(255,255,255,0.9)",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  padding: "1px 4px",
  outline: "none",
  lineHeight: 1,
  width: "100%",
  minWidth: 0,
};

const TITLE_BAR_BRANCH: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: "rgba(255,255,255,0.45)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 180,
  flexShrink: 0,
};

const TITLE_BAR_RIGHT: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  marginLeft: "auto",
  paddingLeft: 8,
};

const TOOL_BTN_BASE: React.CSSProperties = {
  width: "30px",
  height: "30px",
  borderRadius: "8px",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
  transition: "background 0.15s ease, color 0.15s ease",
  padding: 0,
};

function captureScrollPosition(
  term: Terminal,
  autoScrollRef: React.MutableRefObject<boolean>,
  scrollPositionRef: React.MutableRefObject<TerminalScrollPosition>,
) {
  const buffer = term.buffer.active;
  const position = positionFromViewport(buffer.baseY, buffer.viewportY);
  autoScrollRef.current = position.followsOutput;
  scrollPositionRef.current = position;
}

interface TerminalPaneVisibility {
  focusModeActive: boolean;
  isFocused: boolean;
}

/**
 * xterm can report viewportY=0 while its host window/pane is hidden or being
 * collapsed by the focus grid. Those events are layout noise, not user
 * navigation, and must never overwrite the saved follow/history intent.
 */
function isTerminalScrollLayoutUsable(
  term: Terminal,
  paneVisibilityRef: React.MutableRefObject<TerminalPaneVisibility>,
  windowFocusedRef: React.MutableRefObject<boolean>,
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
  programmaticScrollTargetRef: React.MutableRefObject<number | null>,
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
  programmaticScrollTargetRef.current = -1;
  term.scrollToLine(target);
  programmaticScrollTargetRef.current = term.buffer.active.viewportY;
  return true;
}

function restoreScrollPosition(
  term: Terminal,
  autoScrollRef: React.MutableRefObject<boolean>,
  scrollPositionRef: React.MutableRefObject<TerminalScrollPosition>,
  programmaticScrollTargetRef: React.MutableRefObject<number | null>,
  position: TerminalScrollPosition = scrollPositionRef.current,
) {
  const { followsOutput } = position;
  if (followsOutput) {
    scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
    programmaticScrollTargetRef.current = -1;
    term.scrollToBottom();
    programmaticScrollTargetRef.current = term.buffer.active.viewportY;
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
  programmaticScrollTargetRef.current = -1;
  term.scrollToLine(viewportForPosition(term.buffer.active.baseY, position));
  programmaticScrollTargetRef.current = term.buffer.active.viewportY;
  captureScrollPosition(term, autoScrollRef, scrollPositionRef);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isTerminalExitedError(error: unknown): boolean {
  return String(error).toLowerCase().includes("terminal-exited");
}

function runtimeKey(identity: TerminalRuntimeKey): TerminalRuntimeKey {
  return {
    workspaceId: identity.workspaceId,
    generation: identity.generation,
    processId: identity.processId,
  };
}

function currentRuntimeKey(terminalId: string): TerminalRuntimeKey | null {
  const terminal = useTerminalStore.getState().terminals[terminalId];
  if (!terminal || terminal.generation === null) return null;
  return {
    workspaceId: terminal.workspaceId,
    generation: terminal.generation,
    processId: terminal.processId,
  };
}

function sameRuntimeKey(
  left: TerminalRuntimeKey | null,
  right: TerminalRuntimeKey,
): boolean {
  return left !== null &&
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.processId === right.processId;
}

function mergeOutputChunks(chunks: readonly SequencedTerminalChunk[]): Uint8Array {
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
async function syncMeasuredPtySize(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  runtime: TerminalRuntimeKey,
  skipHiddenPane: boolean,
  resizeStateRef: React.MutableRefObject<PtyResizeState>,
  fitInProgressRef: React.MutableRefObject<boolean>,
  windowFocusedRef: React.MutableRefObject<boolean>,
) {
  if (skipHiddenPane) return;

  // The workspace grid has just mounted. Two frames let the grid tracks and
  // the xterm canvas settle before FitAddon reads its cell dimensions.
  await waitForAnimationFrame();
  await waitForAnimationFrame();
  if (!windowFocusedRef.current || document.visibilityState === "hidden") return;
  if (!term.element?.isConnected) return;
  const layoutElement = term.element.parentElement ?? term.element;
  const rect = layoutElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const proposed = fitAddon.proposeDimensions();
  if (
    !proposed ||
    !isStableTerminalLayout({
      windowFocused: windowFocusedRef.current,
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
      windowFocused: windowFocusedRef.current,
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

function fitAndResizePty(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  runtime: TerminalRuntimeKey | null,
  autoScrollRef: React.MutableRefObject<boolean>,
  scrollPositionRef: React.MutableRefObject<TerminalScrollPosition>,
  programmaticScrollTargetRef: React.MutableRefObject<number | null>,
  resizeStateRef: React.MutableRefObject<PtyResizeState>,
  fitInProgressRef: React.MutableRefObject<boolean>,
  windowFocusedRef: React.MutableRefObject<boolean>,
) {
  if (
    runtime === null ||
    !windowFocusedRef.current ||
    document.visibilityState === "hidden"
  ) return;

  const layoutElement = term.element?.parentElement ?? term.element;
  const rect = layoutElement?.getBoundingClientRect();
  const proposed = fitAddon.proposeDimensions();
  if (
    !rect ||
    !proposed ||
    !isStableTerminalLayout({
      windowFocused: windowFocusedRef.current,
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  ) {
    return;
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
    return;
  } finally {
    fitInProgressRef.current = false;
  }
  if (
    !isStableTerminalLayout({
      windowFocused: windowFocusedRef.current,
      documentVisible: document.visibilityState === "visible",
      width: rect.width,
      height: rect.height,
      cols: term.cols,
      rows: term.rows,
    })
  ) {
    return;
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
      programmaticScrollTargetRef,
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
      programmaticScrollTargetRef,
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
        programmaticScrollTargetRef,
        positionBeforeFit,
      );
    }
  } else {
    // There is no scrollback yet. Preserve the reader intent until rehydrate
    // or output creates a scrollable buffer.
    scrollPositionRef.current = positionBeforeFit;
    autoScrollRef.current = false;
    programmaticScrollTargetRef.current = null;
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
}

interface PtyResizeState {
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
  stateRef: React.MutableRefObject<PtyResizeState>,
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

export const TerminalPane = memo(function TerminalPane({
  terminalId,
  shell,
  cwd,
  title: _title,
  agentId,
  terminalCount,
  isActive,
  isFocused = false,
  focusModeActive = false,
  closeRequestToken,
  onActivate,
  onClose,
  onToggleFocus,
  onReorder,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  /** True while backend history is being written and sequenced output is buffered. */
  const rehydratingRef = useRef(false);
  const outputProtocolRef = useRef(new TerminalOutputProtocol());
  const streamEpochRef = useRef(0);
  const terminalGenerationRef = useRef<number | null>(null);
  const terminalProcessIdRef = useRef<number | null>(null);
  const reopeningRef = useRef(false);
  const unsubOutputRef = useRef<(() => void) | null>(null);
  const outputWarmupUnsubRef = useRef<(() => void) | null>(null);
  const unsubExitRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  const scrollPositionRef = useRef<TerminalScrollPosition>({
    followsOutput: true,
    offsetFromBottom: 0,
  });
  const userScrollIntentRef = useRef(false);
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const fitInProgressRef = useRef(false);
  const windowFocusedRef = useRef(true);
  const paneVisibilityRef = useRef<TerminalPaneVisibility>({
    focusModeActive,
    isFocused,
  });
  paneVisibilityRef.current = { focusModeActive, isFocused };
  const followBottomRepairFrameRef = useRef<number | null>(null);
  const followBottomRepairUntilRef = useRef(0);
  const ptyResizeStateRef = useRef<PtyResizeState>({
    pending: null,
    flushing: false,
  });
  const fitScheduleRef = useRef<{
    raf: number | null;
    remainingFrames: number;
  }>({
    raf: null,
    remainingFrames: 0,
  });
  const resizeDebounceRef = useRef<number | null>(null);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const stabilizeFollowBottom = useCallback((durationMs = 1800) => {
    followBottomRepairUntilRef.current = Math.max(
      followBottomRepairUntilRef.current,
      performance.now() + durationMs,
    );
    if (followBottomRepairFrameRef.current !== null) return;

    const run = () => {
      followBottomRepairFrameRef.current = null;
      const term = xtermRef.current;
      if (
        !term ||
        performance.now() >= followBottomRepairUntilRef.current ||
        !scrollPositionRef.current.followsOutput ||
        userScrollIntentRef.current
      ) {
        followBottomRepairUntilRef.current = 0;
        return;
      }

      if (
        isTerminalScrollLayoutUsable(
          term,
          paneVisibilityRef,
          windowFocusedRef,
        )
      ) {
        restoreScrollPosition(
          term,
          autoScrollRef,
          scrollPositionRef,
          programmaticScrollTargetRef,
        );
      }
      followBottomRepairFrameRef.current = requestAnimationFrame(run);
    };

    followBottomRepairFrameRef.current = requestAnimationFrame(run);
  }, []);

  const exitCode = useTerminalStore(
    (s) => s.terminals[terminalId]?.exitCode ?? null,
  );
  const runtimeGeneration = useTerminalStore(
    (s) => s.terminals[terminalId]?.generation ?? null,
  );
  const runtimeProcessId = useTerminalStore(
    (s) => s.terminals[terminalId]?.processId ?? null,
  );
  const terminalWorkspaceId = useTerminalStore(
    (s) => s.terminals[terminalId]?.workspaceId ?? "",
  );
  const hasExited = exitCode !== null;

  const draggedTerminalId = useTerminalStore((s) => s.draggedTerminalId);
  const dragHoveredTerminalId = useTerminalStore((s) => s.dragHoveredTerminalId);
  const isDragHovered = dragHoveredTerminalId === terminalId;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Auto-close pane shortly after natural shell exit.
  useEffect(() => {
    if (!hasExited) return;
    const timer = setTimeout(() => {
      onCloseRef.current?.(terminalId);
    }, 1500);
    return () => clearTimeout(timer);
  }, [hasExited, terminalId]);

  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentCwd, setCurrentCwd] = useState(cwd);
  const [restartToken, setRestartToken] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [streamSyncFailed, setStreamSyncFailed] = useState(false);
  const dragCounterRef = useRef(0);
  const currentCwdRef = useRef(cwd);
  const contextRequestRef = useRef(0);
  const atPowerShellPromptRef = useRef(false);

  // Jarvis can restart a PTY from the backend while this pane stays mounted.
  // A store identity change is the authoritative hand-off to the new lifetime;
  // remount the stream protocol against that exact generation instead of
  // continuing to display/filter with the old one.
  useEffect(() => {
    if (runtimeGeneration === null || !spawnedRef.current) return;
    if (
      terminalGenerationRef.current === runtimeGeneration &&
      terminalProcessIdRef.current === runtimeProcessId
    ) return;

    console.info("[terminal-lifecycle] runtime identity changed", {
      terminalId,
      previousGeneration: terminalGenerationRef.current,
      generation: runtimeGeneration,
      previousProcessId: terminalProcessIdRef.current,
      processId: runtimeProcessId,
    });
    const generationChanged = terminalGenerationRef.current !== runtimeGeneration;
    terminalGenerationRef.current = runtimeGeneration;
    terminalProcessIdRef.current = runtimeProcessId;
    outputProtocolRef.current.startRehydrate({
      workspaceId: terminalWorkspaceId,
      generation: runtimeGeneration,
      processId: runtimeProcessId,
    });
    if (generationChanged) {
      scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
      autoScrollRef.current = true;
      programmaticScrollTargetRef.current = null;
    }
    rehydratingRef.current = true;
    spawnedRef.current = false;
    setRestartToken((token) => token + 1);
  }, [runtimeGeneration, runtimeProcessId, terminalId, terminalWorkspaceId]);

  const scheduleFitAndResize = useCallback((waitFrames = 0) => {
    const schedule = fitScheduleRef.current;
    schedule.remainingFrames = Math.max(schedule.remainingFrames, waitFrames);
    if (schedule.raf !== null) return;

    const run = () => {
      if (schedule.remainingFrames > 0) {
        schedule.remainingFrames -= 1;
        schedule.raf = requestAnimationFrame(run);
        return;
      }

      schedule.raf = null;
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      if (focusModeActive && !isFocused) return;
      if (!windowFocusedRef.current || document.visibilityState === "hidden") return;
      fitAndResizePty(
        term,
        fitAddon,
        terminalId,
        terminalGenerationRef.current === null || !terminalWorkspaceId
          ? null
          : {
              workspaceId: terminalWorkspaceId,
              generation: terminalGenerationRef.current,
              processId: terminalProcessIdRef.current,
            },
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollTargetRef,
        ptyResizeStateRef,
        fitInProgressRef,
        windowFocusedRef,
      );
      if (scrollPositionRef.current.followsOutput) {
        stabilizeFollowBottom();
      }
    };

    schedule.raf = requestAnimationFrame(run);
  }, [focusModeActive, isFocused, stabilizeFollowBottom, terminalId]);

  useEffect(() => {
    currentCwdRef.current = cwd;
    setCurrentCwd(cwd);
  }, [cwd]);

  const refreshTerminalContext = useCallback(async () => {
    const requestId = ++contextRequestRef.current;
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;
    try {
      const context = await invoke<TerminalContext>("terminal_get_context", {
        terminalId,
        ...runtime,
      });
      if (
        requestId !== contextRequestRef.current ||
        !sameRuntimeKey(currentRuntimeKey(terminalId), runtime)
      ) return;
      currentCwdRef.current = context.cwd;
      setCurrentCwd(context.cwd);
      setGitBranch(context.gitBranch);
    } catch (err) {
      console.error(`[branch] context refresh error for ${terminalId}:`, err);
    }
  }, [terminalId]);

  const syncContextFromPowerShellPrompt = useCallback(async (term: Terminal) => {
    const prompt = powerShellPrompt(term);
    if (!prompt) {
      atPowerShellPromptRef.current = false;
      return;
    }
    if (atPowerShellPromptRef.current) return;
    atPowerShellPromptRef.current = true;
    const requestId = ++contextRequestRef.current;
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;

    try {
      const context = sameWindowsPath(prompt.cwd, currentCwdRef.current)
        ? await invoke<TerminalContext>("terminal_get_context", {
            terminalId,
            ...runtime,
          })
        : await invoke<TerminalContext>("terminal_sync_cwd", {
            terminalId,
            ...runtime,
            cwd: prompt.cwd,
          });
      if (
        requestId !== contextRequestRef.current ||
        !sameRuntimeKey(currentRuntimeKey(terminalId), runtime)
      ) return;
      currentCwdRef.current = context.cwd;
      setCurrentCwd(context.cwd);
      setGitBranch(context.gitBranch);
    } catch (err) {
      console.debug(`[branch] prompt CWD sync ignored for ${terminalId}:`, err);
    }
  }, [terminalId, shell]);

  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClose]);

  useEffect(() => {
    if (closeRequestToken === undefined) return;
    setConfirmClose(true);
  }, [closeRequestToken]);

  const pendingDrops = useSkillStore((s) => s.pendingDrops[terminalId]);
  const pendingNames = pendingDrops?.names ?? [];

  useEffect(() => {
    if (!confirmClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmClose(false);
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, [confirmClose]);

  // 1. Create xterm once per mount
  useEffect(() => {
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      // Align with backend vt100 SCROLLBACK_LINES (1000) for remount rehydrate.
      scrollback: 1000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
    }
    scrollPositionRef.current =
      useTerminalStore.getState().terminals[terminalId]?.scrollPosition ??
      scrollPositionRef.current;
    autoScrollRef.current = scrollPositionRef.current.followsOutput;

    dataDisposableRef.current = term.onData((data) => {
      // The current prompt is being edited/executed. The next complete prompt
      // marks command completion even when it has the same CWD and text.
      atPowerShellPromptRef.current = false;
      const tid = terminalIdRef.current;
      if (!tid) return;
      const termState = useTerminalStore.getState().terminals[tid];
      if (
        !termState ||
        termState.exitCode !== null ||
        termState.generation === null
      ) return;
      useTerminalStore.getState().markAgentInput(tid);
      const write = invoke("terminal_write", {
        terminalId: tid,
        workspaceId: termState.workspaceId,
        generation: termState.generation,
        processId: termState.processId,
        data: encodeForPty(data),
      });
      const handleWriteError = (error: unknown) => {
        reportFrontendDiagnostic("terminal-input-error", error, {
          terminalId: tid,
          workspaceId: termState.workspaceId,
          generation: termState.generation ?? undefined,
          processId: termState.processId,
          state: "xterm-input",
        });
        console.warn("[terminal-lifecycle] PTY input rejected", {
          terminalId: tid,
          generation: termState.generation,
          processId: termState.processId,
          error: String(error),
        });
      };

      // PowerShell is refreshed only after its next completed prompt, when
      // commands such as `git checkout` have actually finished. Other shells
      // retain the Enter fallback because their prompt format is unknown.
      if (
        !isPowerShell(shell) &&
        (data.includes("\r") || data.includes("\n"))
      ) {
        write.then(() => void refreshTerminalContext()).catch(handleWriteError);
      } else {
        write.catch(handleWriteError);
      }
    });

    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      // xterm may emit a scroll event while fitAddon.resize() is reflowing the
      // buffer. That is layout work, not user navigation, and must not replace
      // the follow-mode snapshot with a transient viewportY at the top.
      if (fitInProgressRef.current) return;
      if (
        !isTerminalScrollLayoutUsable(
          term,
          paneVisibilityRef,
          windowFocusedRef,
        )
      ) {
        return;
      }

      const userInitiated = userScrollIntentRef.current;
      const programmaticTarget = programmaticScrollTargetRef.current;
      const reconciliation = reconcileScrollSample(scrollPositionRef.current, {
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        layoutStable: true,
        fitInProgress: false,
        userInitiated,
        programmatic: !userInitiated && programmaticTarget !== null,
      });
      if (reconciliation.repairFollow) {
        // Follow mode is authoritative across xterm's asynchronous reflow.
        // This also repairs a viewport that was moved to line zero while the
        // window or pane was hidden.
        restoreScrollPosition(
          term,
          autoScrollRef,
          scrollPositionRef,
          programmaticScrollTargetRef,
        );
        return;
      }

      // Explicit user navigation always wins over a queued/programmatic
      // restore, including the sentinel state used by scrollToLine().
      if (userInitiated) {
        programmaticScrollTargetRef.current = null;
      } else if (programmaticTarget !== null) {
        if (programmaticTarget === term.buffer.active.viewportY) {
          programmaticScrollTargetRef.current = null;
        }
        return;
      }

      // Every non-programmatic xterm scroll event is authoritative. Output
      // can change baseY while a reader is in history, and ignoring these
      // events while writes are pending loses the real viewport under load.
      if (reconciliation.captured) {
        scrollPositionRef.current = reconciliation.position;
        autoScrollRef.current = reconciliation.position.followsOutput;
      }
      userScrollIntentRef.current = false;
      if (!scrollPositionRef.current.followsOutput) {
        followBottomRepairUntilRef.current = 0;
      }
    });

    let disposed = false;
    const scheduleUserScrollCapture = () => {
      requestAnimationFrame(() => {
        if (disposed || xtermRef.current !== term) return;
        if (
          isTerminalScrollLayoutUsable(
            term,
            paneVisibilityRef,
            windowFocusedRef,
          )
        ) {
          captureScrollPosition(term, autoScrollRef, scrollPositionRef);
        }
        userScrollIntentRef.current = false;
      });
    };
    const onWheel = (event: WheelEvent) => {
      userScrollIntentRef.current = true;
      // Stop a queued output callback from snapping back before the browser
      // applies this upward wheel movement.
      if (event.deltaY < 0) {
        followBottomRepairUntilRef.current = 0;
        autoScrollRef.current = false;
        scrollPositionRef.current = {
          followsOutput: false,
          offsetFromBottom: Math.max(1, scrollPositionRef.current.offsetFromBottom),
        };
      }
      // Applications using the alternate buffer/mouse reporting own the
      // regular wheel event. Shift+wheel is the standard terminal-emulator
      // escape hatch: keep the agent's mouse interaction intact while still
      // allowing the user to inspect xterm scrollback when it exists.
      if (event.shiftKey && term.buffer.active.type === "normal") {
        event.preventDefault();
        event.stopPropagation();
        const magnitude = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? Math.abs(event.deltaY)
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.abs(event.deltaY) * term.rows
            : Math.max(1, Math.round(Math.abs(event.deltaY) / 20));
        term.scrollLines(Math.max(1, magnitude) * (event.deltaY < 0 ? -1 : 1));
      }
      scheduleUserScrollCapture();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      userScrollIntentRef.current = true;
      if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp") {
        followBottomRepairUntilRef.current = 0;
        autoScrollRef.current = false;
      }
      scheduleUserScrollCapture();
    };
    const onPointerDown = (event: PointerEvent) => {
      const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const scrollbarWidth = Math.max(16, viewport.offsetWidth - viewport.clientWidth);
      if (event.clientX < rect.right - scrollbarWidth) return;
      // Covers drag of xterm's scrollbar. Suspend immediately so a queued
      // output callback cannot pull the thumb back to the live bottom.
      userScrollIntentRef.current = true;
      followBottomRepairUntilRef.current = 0;
      autoScrollRef.current = false;
      scrollPositionRef.current = {
        followsOutput: false,
        offsetFromBottom: Math.max(1, scrollPositionRef.current.offsetFromBottom),
      };
    };
    // WebView2 can expose the native scrollbar as a mouse event without a
    // reliable pointer event. Treat both paths as explicit user navigation.
    const onMouseDown = (event: MouseEvent) => {
      onPointerDown(event as unknown as PointerEvent);
    };
    const container = containerRef.current;
    container?.addEventListener("wheel", onWheel, { passive: false, capture: true });
    container?.addEventListener("keydown", onKeyDown, { capture: true });
    container?.addEventListener("pointerdown", onPointerDown, { capture: true });
    container?.addEventListener("mousedown", onMouseDown, { capture: true });

    return () => {
      disposed = true;
      // Do not sample xterm during teardown. React can unmount this pane while
      // its host grid is collapsing, and xterm may report viewportY=0 for that
      // layout-only transition. All valid user scroll events have already
      // updated scrollPositionRef, so saving the last known intent is safer.
      useTerminalStore.getState().saveScrollPosition(
        terminalIdRef.current,
        terminalGenerationRef.current,
        scrollPositionRef.current,
      );
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
      unsubExitRef.current?.();
      unsubExitRef.current = null;
      dataDisposableRef.current?.dispose();
      dataDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      container?.removeEventListener("wheel", onWheel, { capture: true });
      container?.removeEventListener("keydown", onKeyDown, { capture: true });
      container?.removeEventListener("pointerdown", onPointerDown, { capture: true });
      container?.removeEventListener("mousedown", onMouseDown, { capture: true });
      if (fitScheduleRef.current.raf !== null) {
        cancelAnimationFrame(fitScheduleRef.current.raf);
        fitScheduleRef.current.raf = null;
        fitScheduleRef.current.remainingFrames = 0;
      }
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      if (followBottomRepairFrameRef.current !== null) {
        cancelAnimationFrame(followBottomRepairFrameRef.current);
        followBottomRepairFrameRef.current = null;
      }
      followBottomRepairUntilRef.current = 0;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [refreshTerminalContext, shell, terminalId]);

  // Prime the shared output listener before the spawn effect below runs. The
  // Tauri listen registration is asynchronous, so the spawn effect also waits
  // for it before the shell can emit its first prompt.
  useEffect(() => {
    outputWarmupUnsubRef.current?.();
    outputWarmupUnsubRef.current = subscribeTerminalOutput(terminalId, () => {});
    return () => {
      outputWarmupUnsubRef.current?.();
      outputWarmupUnsubRef.current = null;
    };
  }, [terminalId]);

  // 2. Spawn PTY + optional screen rehydrate + agent launch
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t?.generation !== null && t?.generation !== undefined) {
      terminalGenerationRef.current = t.generation;
      terminalProcessIdRef.current = t.processId;
      outputProtocolRef.current.startRehydrate({
        workspaceId: t.workspaceId,
        generation: t.generation,
        processId: t.processId,
      });
    }
    spawnedRef.current = true;
    const epoch = ++streamEpochRef.current;
    let disposed = false;
    const isCurrent = () =>
      !disposed && streamEpochRef.current === epoch && xtermRef.current === term;

    // Always take a backend snapshot. On first open the shell can emit its
    // prompt before the React event listener is attached; treating the
    // parser as authoritative closes that initial-output race too.
    // Set this before any await: terminal_spawn and terminal_resize can
    // trigger output from a live TUI while the new xterm is still empty.
    rehydratingRef.current = true;

    const cols = Math.max(term.cols, 80);
    const rows = Math.max(term.rows, 24);
    let spawnSucceeded = false;
    const replayBufferedOutput = async () => {
      while (isCurrent()) {
        const replay = outputProtocolRef.current.takeReplay();
        if (replay.kind === "gap") {
          throw new Error(
            `terminal-output-gap: expected ${replay.expected}, received ${replay.received}`,
          );
        }
        if (replay.kind === "chunks") {
          await new Promise<void>((resolve) =>
            term.write(mergeOutputChunks(replay.chunks), resolve),
          );
          continue;
        }
        // Empty-check and live transition are one synchronous operation. If an
        // output callback appended data earlier, cutover returns false and the
        // loop replays it; no final chunk can be stranded in a dead queue.
        if (outputProtocolRef.current.cutoverToLive()) {
          rehydratingRef.current = false;
          setStreamSyncFailed(false);
          return;
        }
      }
      throw new Error("terminal-stream-superseded");
    };
    const restoreSnapshot = async (expectedRuntime: TerminalRuntimeKey | null) => {
      const rehydrateState = await invoke<TerminalRehydrateState>("terminal_get_screen_text", {
        terminalId,
        workspaceId: expectedRuntime?.workspaceId ?? terminalWorkspaceId,
        expectedGeneration: expectedRuntime?.generation ?? null,
        expectedProcessId: expectedRuntime?.processId ?? null,
      });
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      const snapshotRuntime = runtimeKey(rehydrateState);
      if (
        expectedRuntime &&
        (rehydrateState.workspaceId !== expectedRuntime.workspaceId ||
          rehydrateState.generation !== expectedRuntime.generation ||
          rehydrateState.processId !== expectedRuntime.processId)
      ) {
        throw new Error("stale-terminal-generation: rehydrate snapshot changed");
      }
      if (!outputProtocolRef.current.currentRuntime()) {
        outputProtocolRef.current.startRehydrate(snapshotRuntime);
      }
      terminalGenerationRef.current = rehydrateState.generation;
      terminalProcessIdRef.current = rehydrateState.processId;
      outputProtocolRef.current.installSnapshot(
        snapshotRuntime,
        rehydrateState.outputSequence,
      );
      const termNow = xtermRef.current;
      if (!termNow) return;

      // The backend stream contains a complete formatted state, including
      // cursor, attributes, alternate screen, and input modes. Reset is safe
      // even for a blank screen.
      termNow.reset();
      if (
        rehydrateState.cols > 0 &&
        rehydrateState.rows > 0 &&
        (termNow.cols !== rehydrateState.cols || termNow.rows !== rehydrateState.rows)
      ) {
        termNow.resize(rehydrateState.cols, rehydrateState.rows);
      }
      if (rehydrateState.history.length > 0) {
        await new Promise<void>((resolve) =>
          termNow.write(new Uint8Array(rehydrateState.history), resolve),
        );
      }
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      if (rehydrateState.state.length > 0) {
        await new Promise<void>((resolve) =>
          termNow.write(new Uint8Array(rehydrateState.state), resolve),
        );
      }
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      await replayBufferedOutput();
      restoreScrollPosition(
        termNow,
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollTargetRef,
      );
      if (scrollPositionRef.current.followsOutput) {
        stabilizeFollowBottom(2000);
      }
      if (termNow.rows > 0) {
        termNow.refresh(0, termNow.rows - 1);
      }
    };
    const restoreWithBoundedRetry = async (
      expectedRuntime: TerminalRuntimeKey | null,
    ) => {
      let expected = expectedRuntime;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await restoreSnapshot(expected);
          return;
        } catch (error) {
          lastError = error;
          if (!isCurrent() || String(error).includes("stale-terminal")) throw error;
          if (attempt === 1) {
            console.warn("[terminal-output] bounded rehydrate retry", {
              terminalId,
              generation: expected?.generation ?? null,
              processId: expected?.processId ?? null,
              error: String(error),
            });
            expected = outputProtocolRef.current.currentRuntime();
            if (expected) outputProtocolRef.current.startRehydrate(expected);
          }
        }
      }
      throw lastError;
    };

    void (async () => {
      try {
        await waitForTerminalOutputListener();
        if (!isCurrent()) return;
        if (t?.exitCode !== null && t?.generation != null) {
          await restoreWithBoundedRetry({
            workspaceId: t.workspaceId,
            generation: t.generation,
            processId: t.processId,
          });
          return;
        }
        const runtime = await invoke<TerminalRuntimeIdentity>("terminal_spawn", {
          terminalId,
          shell,
          cwd,
          cols,
          rows,
          workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
          agentId: agentId ?? null,
        });
        if (!isCurrent()) return;
        if (!terminalWorkspaceId || runtime.workspaceId !== terminalWorkspaceId) {
          throw new Error(
            `stale-terminal-workspace: expected ${terminalWorkspaceId || "missing"}, current ${runtime.workspaceId || "missing"}`,
          );
        }
        terminalGenerationRef.current = runtime.generation;
        terminalProcessIdRef.current = runtime.processId;
        outputProtocolRef.current.startRehydrate(runtimeKey(runtime));
        spawnSucceeded = true;
        useTerminalStore.getState().markSpawned(
          terminalId,
          runtime.workspaceId,
          runtime.generation,
          runtime.processId,
        );
        if (runtime.agentLaunchOwner === "backend" && runtime.agentLaunchState) {
          useTerminalStore.getState().markBackendAgentLaunch(
            terminalId,
            runtime.workspaceId,
            runtime.generation,
            runtime.processId,
            runtime.agentLaunchState,
          );
        }

        // Carica il branch git all'avvio del terminale (primo mount + rehydrate).
        // Il backend ritorna Ok(Some("main")) → "main" | Ok(None) → null
        void refreshTerminalContext();

        const fitAddon = fitAddonRef.current;
        if (fitAddon) {
          await syncMeasuredPtySize(
            term,
            fitAddon,
            terminalId,
            runtimeKey(runtime),
            focusModeActive && !isFocused,
            ptyResizeStateRef,
            fitInProgressRef,
            windowFocusedRef,
          );
        }
        await restoreWithBoundedRetry(runtimeKey(runtime));
        if (isCurrent()) {
          await syncContextFromPowerShellPrompt(term);
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (isTerminalExitedError(error)) {
          // The backend keeps the dead parser so the last screen can still be
          // displayed even when the pane was unmounted at exit time.
          rehydratingRef.current = true;
          try {
            await restoreWithBoundedRetry(
              terminalGenerationRef.current === null
                ? null
                : {
                    workspaceId: terminalWorkspaceId,
                    generation: terminalGenerationRef.current,
                    processId: terminalProcessIdRef.current,
                  },
            );
          } catch (snapshotError) {
            reportFrontendDiagnostic("terminal-snapshot-error", snapshotError, {
              terminalId,
              workspaceId: terminalWorkspaceId,
              generation: terminalGenerationRef.current ?? undefined,
              processId: terminalProcessIdRef.current,
              state: "exited-rehydrate",
            });
            console.error("[terminal-output] exited snapshot failed", {
              terminalId,
              error: String(snapshotError),
            });
          }
          const exitCodeMatch = String(error).match(/exit(?:[-_ ]?code)?\s*[:=]\s*(-?\d+)/i);
          const exitedGeneration = terminalGenerationRef.current;
          if (exitedGeneration !== null) {
            useTerminalStore.getState().markExited(
              terminalId,
              terminalWorkspaceId,
              exitedGeneration,
              terminalProcessIdRef.current,
              exitCodeMatch ? Number(exitCodeMatch[1]) : 0,
            );
          }
        } else {
          spawnedRef.current = false;
          setStreamSyncFailed(true);
          reportFrontendDiagnostic("terminal-lifecycle-error", error, {
            terminalId,
            workspaceId: terminalWorkspaceId,
            generation: terminalGenerationRef.current ?? undefined,
            processId: terminalProcessIdRef.current,
            state: outputProtocolRef.current.isBuffering() ? "buffering" : "live",
          });
          console.error("[terminal-output] lifecycle failed", {
            terminalId,
            generation: terminalGenerationRef.current,
            processId: terminalProcessIdRef.current,
            error: String(error),
          });
          term.write(
            "\r\n\x1b[31m[Traflix: impossibile sincronizzare il terminale; riaprilo per riprovare]\x1b[0m\r\n",
          );
        }
      } finally {
        if (isCurrent()) {
          rehydratingRef.current = outputProtocolRef.current.isBuffering();
          reopeningRef.current = false;
        }
      }

      if (isCurrent() && agentId && spawnSucceeded) {
        const store = useTerminalStore.getState();
        const terminal = store.terminals[terminalId];
        if (
          terminal?.generation !== null &&
          terminal?.generation !== undefined &&
          !terminal.agentLaunched &&
          terminal.agentLaunchOwner !== "backend"
        ) {
          store.markAgentLaunched(terminalId, terminal.generation);
          agentLaunchQueue.enqueue(terminalId, terminal.generation, agentId);
        }
      }
    })();

    return () => {
      disposed = true;
      if (streamEpochRef.current === epoch) streamEpochRef.current += 1;
    };
  }, [terminalId, shell, cwd, agentId, refreshTerminalContext, stabilizeFollowBottom, restartToken]);

  // 2b. Listen for CWD changes from backend (cd command detected) → refresh git branch.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let disposed = false;
    listen<TerminalCwdChangedPayload>("terminal-cwd-changed", (event) => {
      const payload = event.payload;
      if (
        payload.terminalId === terminalId &&
        sameRuntimeKey(currentRuntimeKey(terminalId), payload)
      ) {
        currentCwdRef.current = payload.cwd;
        setCurrentCwd(payload.cwd);
        console.log(`[branch] cwd-changed event for ${terminalId}, re-fetching`);
        void refreshTerminalContext();
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlistenFn = fn;
      }
    }).catch((error) => {
      reportFrontendDiagnostic("terminal-listener-error", error, {
        terminalId,
        workspaceId: terminalWorkspaceId,
        generation: terminalGenerationRef.current ?? undefined,
        processId: terminalProcessIdRef.current,
        state: "cwd-listener",
      });
      console.error("[terminal-lifecycle] CWD listener setup failed", error);
    });
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, [terminalId, terminalWorkspaceId, refreshTerminalContext]);

  // 3. Active focus + backend active flag (skip heavy refresh when hidden in focus mode)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Hidden under another pane's focus mode — do not fit/resize to 0×0.
    if (focusModeActive && !isFocused) return;

    if (isActive || isFocused) {
      const focusFrame = requestAnimationFrame(() => {
        scheduleFitAndResize();
        if (isActive || isFocused) {
          term.focus();
          term.clearSelection();
        }
      });
      const identity = useTerminalStore.getState().terminals[terminalId];
      if (identity?.generation != null) {
        invoke("terminal_set_active", {
          terminalId,
          workspaceId: identity.workspaceId,
          generation: identity.generation,
          processId: identity.processId,
        }).catch((error) => {
          console.warn("[terminal-lifecycle] active PTY rejected", {
            terminalId,
            workspaceId: identity.workspaceId,
            generation: identity.generation,
            processId: identity.processId,
            error: String(error),
          });
          });
      }
      return () => cancelAnimationFrame(focusFrame);
    }
  }, [isActive, isFocused, focusModeActive, terminalId, scheduleFitAndResize]);

  // 3b. Enter/exit focus mode — always re-fit the focused pane (or all when leaving)
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const entered = isFocused && !wasFocusedRef.current;
    const exited = !isFocused && wasFocusedRef.current;
    wasFocusedRef.current = isFocused;

    if (!entered && !exited) return;
    // When exiting focus mode, every visible pane needs a fit; when entering,
    // only the focused pane is visible.
    if (focusModeActive && !isFocused) return;

    const term = xtermRef.current;
    if (!term) return;

    // Wait for layout after the grid CSS change. Calls from this effect,
    // active/focused state and ResizeObserver are coalesced per pane.
    scheduleFitAndResize(2);
    if (isFocused || isActive) term.focus();
  }, [isFocused, focusModeActive, isActive, terminalId, scheduleFitAndResize]);

  // When leaving global focus mode, non-focused panes become visible again → fit.
  const prevFocusModeRef = useRef(focusModeActive);
  useEffect(() => {
    const leftFocusMode = prevFocusModeRef.current && !focusModeActive;
    prevFocusModeRef.current = focusModeActive;
    if (!leftFocusMode) return;

    scheduleFitAndResize(2);
  }, [focusModeActive, terminalId, scheduleFitAndResize]);

  // Native tray hide/show and application switches can make xterm recalculate
  // its viewport while it has no usable layout. Re-fit and restore follow mode
  // after the window becomes interactive again.
  useEffect(() => {
    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
    };
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
      if (focusModeActive && !isFocused) return;
      scheduleFitAndResize(1);
      if (scrollPositionRef.current.followsOutput) {
        stabilizeFollowBottom(2000);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        windowFocusedRef.current = false;
      } else {
        handleWindowFocus();
      }
    };

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [focusModeActive, isFocused, scheduleFitAndResize, stabilizeFollowBottom]);

  // 4a. Output — shared bus + rAF batch (already coalesced in terminalEvents)
  useEffect(() => {
    outputWarmupUnsubRef.current?.();
    outputWarmupUnsubRef.current = null;
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, (payload) => {
      const chunks: SequencedTerminalChunk[] = payload.chunks ?? [{
        workspaceId: payload.workspaceId,
        sequence: payload.sequence,
        generation: payload.generation,
        processId: payload.processId,
        data: new Uint8Array(payload.data),
      }];
      const result = outputProtocolRef.current.ingest(chunks);
      if (result.resyncRequired) {
        reportFrontendDiagnostic("terminal-output-resync", "terminal-output-gap", {
          terminalId,
          workspaceId: payload.workspaceId,
          generation: payload.generation,
          processId: payload.processId,
          state: "sequence-gap",
        });
        console.warn("[terminal-output] sequence gap; requesting authoritative snapshot", {
          terminalId,
          generation: payload.generation,
          processId: payload.processId,
          receivedSequence: payload.sequence,
          lastDeliveredSequence: outputProtocolRef.current.lastDeliveredSequence(),
        });
        rehydratingRef.current = true;
        spawnedRef.current = false;
        setRestartToken((token) => token + 1);
        return;
      }
      if (result.deliver.length === 0) return;
      const data = mergeOutputChunks(result.deliver);
      const term = xtermRef.current;
      if (!term) return;
      const deliveredRuntime = runtimeKey(result.deliver[0]);
      const baseYBeforeWrite = term.buffer.active.baseY;
      term.write(data, () => {
        if (
          xtermRef.current !== term ||
          !sameRuntimeKey(currentRuntimeKey(terminalId), deliveredRuntime)
        ) {
          return;
        }
        void syncContextFromPowerShellPrompt(term);
        // xterm writes asynchronously. Scrolling before this callback uses the
        // previous baseY and leaves the viewport one or more chunks behind.
        // Check the current value so a user scroll during a large agent output
        // is respected instead of being pulled back to the bottom.
        if (scrollPositionRef.current.followsOutput && !userScrollIntentRef.current) {
          autoScrollRef.current = true;
          scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
          if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
            restoreScrollPosition(
              term,
              autoScrollRef,
              scrollPositionRef,
              programmaticScrollTargetRef,
            );
          }
          stabilizeFollowBottom(1200);
        } else if (
          isTerminalScrollLayoutUsable(
            term,
            paneVisibilityRef,
            windowFocusedRef,
          )
        ) {
          // Output changes baseY while a reader stays at an older line. Record
          // the new relative offset so a later resize/remount returns here.
          captureScrollPosition(term, autoScrollRef, scrollPositionRef);
        } else if (!scrollPositionRef.current.followsOutput) {
          // While hidden, viewportY can be a layout artifact but the increase
          // in baseY caused by this exact write is still meaningful. Grow the
          // saved distance from the bottom so continuous TUI output does not
          // move a reader forward when the pane becomes visible again.
          scrollPositionRef.current = positionAfterHiddenOutput(
            scrollPositionRef.current,
            baseYBeforeWrite,
            term.buffer.active.baseY,
          );
        }
      });
    });
    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
    };
  }, [terminalId, stabilizeFollowBottom, syncContextFromPowerShellPrompt]);

  // 4b. Exit
  useEffect(() => {
    unsubExitRef.current?.();
    unsubExitRef.current = subscribeTerminalExit(
      terminalId,
      ({ terminalId: tid, workspaceId, generation, processId, exitCode: code }) => {
        if (reopeningRef.current) return;
        if (workspaceId !== terminalWorkspaceId) return;
        if (
          terminalGenerationRef.current !== null &&
          generation !== terminalGenerationRef.current
        ) {
          return;
        }
        if (
          terminalProcessIdRef.current !== null &&
          processId !== null &&
          processId !== terminalProcessIdRef.current
        ) {
          return;
        }
        useTerminalStore.getState().markExited(
          tid,
          workspaceId,
          generation,
          processId,
          code,
        );
      },
    );
    return () => {
      unsubExitRef.current?.();
      unsubExitRef.current = null;
    };
  }, [terminalId, terminalWorkspaceId]);

  // 5. ResizeObserver — skip when this pane is hidden under focus mode
  useEffect(() => {
    const handleResize = () => {
      if (focusModeActive && !isFocused) return;
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
      }
      resizeDebounceRef.current = window.setTimeout(() => {
        resizeDebounceRef.current = null;
        scheduleFitAndResize();
      }, 150);
    };

    const container = containerRef.current;
    if (!container) return;

    const raf = requestAnimationFrame(() => {
      if (focusModeActive && !isFocused) return;
      scheduleFitAndResize();
    });

    const observer = new ResizeObserver(() => {
      if (focusModeActive && !isFocused) return;
      handleResize();
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      observer.disconnect();
    };
  }, [terminalId, focusModeActive, isFocused, scheduleFitAndResize]);

  useTerminalInput(terminalId, containerRef, xtermRef);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const handleMouseDown = () => {
      useTerminalStore.getState().clearAgentAttention(terminalId);
      if (!isActiveRef.current) {
        onActivate(terminalId);
      }
    };
    el.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () =>
      el.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, [terminalId, onActivate]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(true);
  }, []);

  const handleConfirmClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setConfirmClose(false);
      onClose?.(terminalId);
    },
    [terminalId, onClose],
  );

  const handleCancelClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
  }, []);

  const handleToggleFocus = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFocus?.(terminalId);
    },
    [terminalId, onToggleFocus],
  );

  // Titolo visualizzato: prima controlla se l'utente ha rinominato, poi deriva.
  const customTitle = useTerminalStore((s) => s.terminalTitles[terminalId]);
  const agentStatus = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentStatus ?? "idle",
  );
  const agentAttentionRequired = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentAttentionRequired ?? false,
  );
  const previousAgentStatusRef = useRef(agentStatus);
  useEffect(() => {
    const completedNow =
      agentStatus === "completed" &&
      previousAgentStatusRef.current !== "completed";
    previousAgentStatusRef.current = agentStatus;
    if (completedNow && scrollPositionRef.current.followsOutput) {
      stabilizeFollowBottom(2000);
    }
  }, [agentStatus, stabilizeFollowBottom]);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspaceIndex = workspaces.findIndex(
    (workspace) => workspace.id === terminalWorkspaceId,
  );
  const workspaceColor = getWorkspaceColor(
    workspaceIndex >= 0 ? workspaceIndex : 0,
  );
  const displayTitle =
    customTitle ??
    (agentId
      ? `${agentDisplayName(agentId)} — ${projectNameFromCwd(currentCwd)}`
      : `${shell} — ${projectNameFromCwd(currentCwd)}`);

  const titleBarMetrics = getTitleBarMetrics(terminalCount);
  const titleBarStyle: React.CSSProperties = {
    ...TITLE_BAR_STYLE,
    height: titleBarMetrics.height,
    minHeight: titleBarMetrics.height,
    padding: titleBarMetrics.padding,
    position: "relative",
  };

  const handleStartRename = useCallback(() => {
    setEditValue(displayTitle);
    setEditing(true);
  }, [displayTitle]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayTitle) {
      useTerminalStore.getState().renameTerminal(terminalId, trimmed);
      void invokeWithTimeout(
        () =>
          invoke("update_terminal_title", {
            workspaceId: terminalWorkspaceId,
            terminalId,
            title: trimmed,
          }),
        10000,
      ).catch(() => undefined);
    }
    setEditing(false);
  }, [displayTitle, editValue, terminalId, terminalWorkspaceId]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleRenameSubmit();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
      e.stopPropagation();
    },
    [handleRenameSubmit],
  );

  const handleRestart = useCallback(async () => {
    try {
      reopeningRef.current = true;
      rehydratingRef.current = true;
      const expectedGeneration = terminalGenerationRef.current ??
        useTerminalStore.getState().terminals[terminalId]?.generation;
      if (expectedGeneration === null || expectedGeneration === undefined) {
        throw new Error("terminal identity unavailable for reopen");
      }
      outputProtocolRef.current.startRehydrate({
        workspaceId: terminalWorkspaceId,
        generation: expectedGeneration,
        processId: terminalProcessIdRef.current,
      });
      const runtime = await invoke<TerminalRuntimeIdentity>("terminal_reopen", {
        terminalId,
        expectedGeneration,
        expectedProcessId: terminalProcessIdRef.current,
        shell,
        cwd: currentCwd,
        cols: xtermRef.current?.cols ?? 80,
        rows: xtermRef.current?.rows ?? 24,
        workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
        agentId: agentId ?? null,
      });
      if (!terminalWorkspaceId || runtime.workspaceId !== terminalWorkspaceId) {
        throw new Error(
          `stale-terminal-workspace: expected ${terminalWorkspaceId || "missing"}, current ${runtime.workspaceId || "missing"}`,
        );
      }
      terminalGenerationRef.current = runtime.generation;
      terminalProcessIdRef.current = runtime.processId;
      outputProtocolRef.current.startRehydrate(runtimeKey(runtime));
      scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
      autoScrollRef.current = true;
      programmaticScrollTargetRef.current = null;
      useTerminalStore.getState().markSpawned(
        terminalId,
        runtime.workspaceId,
        runtime.generation,
        runtime.processId,
      );
      spawnedRef.current = false;
      setRestartToken((token) => token + 1);
    } catch (err) {
      reopeningRef.current = false;
      rehydratingRef.current = false;
      reportFrontendDiagnostic("terminal-reopen-error", err, {
        terminalId,
        workspaceId: terminalWorkspaceId,
        generation: terminalGenerationRef.current ?? undefined,
        processId: terminalProcessIdRef.current,
        state: "reopen",
      });
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, terminalWorkspaceId, shell, currentCwd, agentId]);

  const handleRetryStreamSync = useCallback(() => {
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;
    outputProtocolRef.current.startRehydrate(runtime);
    terminalGenerationRef.current = runtime.generation;
    terminalProcessIdRef.current = runtime.processId;
    rehydratingRef.current = true;
    spawnedRef.current = false;
    setStreamSyncFailed(false);
    setRestartToken((token) => token + 1);
  }, [terminalId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("application/x-traflix-terminal-id")) {
      e.dataTransfer.dropEffect = "move";
    } else {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      dragCounterRef.current = 0;
      try {
        const draggedTerminalId = e.dataTransfer.getData("application/x-traflix-terminal-id");
        if (draggedTerminalId) {
          if (draggedTerminalId !== terminalId && onReorder) {
            onReorder(draggedTerminalId, terminalId);
          }
          return;
        }

        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.type === "skill" && data.name) {
            const store = useTerminalStore.getState();
            const terminal = store.terminals[terminalId];
            if (!terminal || terminal.generation === null) return;
            store.markAgentInput(terminalId);
            useSkillStore.getState().addPendingDrop(terminalId, {
              workspaceId: terminal.workspaceId,
              generation: terminal.generation,
              processId: terminal.processId,
            }, data.name);
            return;
          }
        }
        const text = e.dataTransfer.getData("text/plain");
        if (text && text.trim()) {
          const skills = useSkillStore.getState().skills;
          const matchedSkill = skills.find(
            (s) => s.name.toLowerCase() === text.trim().toLowerCase(),
          );
          if (matchedSkill) {
            const store = useTerminalStore.getState();
            const terminal = store.terminals[terminalId];
            if (!terminal || terminal.generation === null) return;
            store.markAgentInput(terminalId);
            useSkillStore
              .getState()
              .addPendingDrop(terminalId, {
                workspaceId: terminal.workspaceId,
                generation: terminal.generation,
                processId: terminal.processId,
              }, matchedSkill.name);
          }
        }
      } catch {
        // ignore
      }
    },
    [terminalId, onReorder],
  );

  const outerStyle = hasExited
    ? EXITED_STYLE
    : isFocused
      ? FOCUSED_STYLE
      : isActive
        ? ACTIVE_STYLE
        : INACTIVE_STYLE;

  const dragOverlayStyle = isDragOver
    ? {
        borderColor: "var(--color-primary)",
        boxShadow:
          "inset 0 0 0 1px var(--color-primary), 0 0 16px rgba(232,93,4,0.15)",
      }
    : {};
  const attentionClass =
    agentAttentionRequired && !hasExited ? "agent-attention-pulse" : undefined;

  return (
    <div
      data-terminal-pane-id={terminalId}
      className={attentionClass}
      style={{
        ...outerStyle,
        ...(agentAttentionRequired && !hasExited
          ? { borderColor: "var(--color-primary)" }
          : {}),
        ...dragOverlayStyle,
      }}
      tabIndex={-1}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Full-pane drag overlay for reordering */}
      {draggedTerminalId !== null && draggedTerminalId !== terminalId && (
        <div
          onPointerEnter={() => {
            useTerminalStore.getState().setDragHoveredTerminalId(terminalId);
          }}
          onPointerLeave={() => {
            const state = useTerminalStore.getState();
            if (state.dragHoveredTerminalId === terminalId) {
              state.setDragHoveredTerminalId(null);
            }
          }}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: isDragHovered ? "rgba(18, 18, 18, 0.92)" : "rgba(18, 18, 18, 0.45)",
            border: isDragHovered ? "2px dashed var(--color-primary)" : "2px dashed rgba(255, 255, 255, 0.12)",
            borderRadius: "var(--radius-pane)",
            backdropFilter: isDragHovered ? "blur(4px)" : "none",
            transition: "all 0.2s ease-in-out",
          }}
        >
          {isDragHovered && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
                color: "var(--color-primary)",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "14px",
                textShadow: "0 0 10px rgba(232, 93, 4, 0.4)",
              }}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-bounce"
              >
                <path d="M12 5v14" />
                <path d="m19 12-7 7-7-7" />
              </svg>
              <span>Rilascia per spostare</span>
            </div>
          )}
        </div>
      )}
      {/* Title bar: workspace dot + name (left) | branch + buttons (right) */}
      <div style={titleBarStyle}>
        <div
          style={{
            ...TITLE_BAR_LEFT,
            gap: titleBarMetrics.dotSize,
            maxWidth: terminalCount > 1 ? "calc(50% - 32px)" : undefined,
          }}
        >
          <div
            style={{
              ...TITLE_BAR_DOT,
              width: titleBarMetrics.dotSize,
              height: titleBarMetrics.dotSize,
              background: workspaceColor,
            }}
          />
          {editing ? (
            <input
              style={{
                ...TITLE_BAR_RENAME_INPUT,
                fontSize: titleBarMetrics.fontSize,
              }}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              autoFocus
            />
          ) : (
            <span
              style={{ ...TITLE_BAR_NAME, fontSize: titleBarMetrics.fontSize }}
              onDoubleClick={handleStartRename}
            >
              {displayTitle}
            </span>
          )}
        </div>

        {/* Centered larger drag handle button */}
        {!hasExited && terminalCount > 1 && (
          <div
            onPointerDown={(e) => {
              if (dragCleanupRef.current) return;
              e.preventDefault();

              const pointerId = e.pointerId;
              const store = useTerminalStore.getState();
              store.setDraggedTerminalId(terminalId);

              const paneEl = e.currentTarget.parentElement?.parentElement;
              if (paneEl) {
                paneEl.style.setProperty("opacity", "0.35");
              }

              const resolveDragTarget = (clientX: number, clientY: number) => {
                const element = document.elementFromPoint(clientX, clientY);
                const pane = element?.closest<HTMLElement>("[data-terminal-pane-id]");
                const targetId = pane?.dataset.terminalPaneId ?? null;
                const latestStore = useTerminalStore.getState();
                latestStore.setDragHoveredTerminalId(
                  targetId && targetId !== terminalId ? targetId : null,
                );
              };

              const cleanup = () => {
                if (dragCleanupRef.current !== cleanup) return;
                dragCleanupRef.current = null;
                const latestStore = useTerminalStore.getState();
                latestStore.setDraggedTerminalId(null);
                latestStore.setDragHoveredTerminalId(null);
                if (paneEl) {
                  paneEl.style.removeProperty("opacity");
                }
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerCancel);
                window.removeEventListener("blur", handleWindowBlur);
              };

              const handlePointerMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== pointerId) return;
                moveEvent.preventDefault();
                resolveDragTarget(moveEvent.clientX, moveEvent.clientY);
              };

              const handlePointerUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== pointerId) return;
                upEvent.preventDefault();
                resolveDragTarget(upEvent.clientX, upEvent.clientY);
                const latestStore = useTerminalStore.getState();
                const targetId = latestStore.dragHoveredTerminalId;

                if (targetId && targetId !== terminalId && onReorder) {
                  onReorder(terminalId, targetId);
                }
                cleanup();
              };

              const handlePointerCancel = (cancelEvent: PointerEvent) => {
                if (cancelEvent.pointerId === pointerId) cleanup();
              };

              const handleWindowBlur = () => cleanup();

              dragCleanupRef.current = cleanup;
              window.addEventListener("pointermove", handlePointerMove);
              window.addEventListener("pointerup", handlePointerUp);
              window.addEventListener("pointercancel", handlePointerCancel);
              window.addEventListener("blur", handleWindowBlur);
            }}
            title="Trascina la barra al centro per spostare il terminale"
            aria-label="Trascina la barra al centro per spostare il terminale"
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "48px",
              height: "24px",
              borderRadius: "6px",
              cursor: "grab",
              color: "rgba(255,255,255,0.35)",
              backgroundColor: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              transition: "all 0.15s ease",
              zIndex: 10,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
              e.currentTarget.style.borderColor = "var(--color-primary)";
              e.currentTarget.style.color = "var(--color-primary)";
              e.currentTarget.style.boxShadow = "0 0 10px rgba(232,93,4,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.02)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = "rgba(255,255,255,0.35)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <GripHorizontal size={18} />
          </div>
        )}

        <div style={TITLE_BAR_RIGHT}>
          {agentStatus === "completed" && agentAttentionRequired && (
            <span
              title="L'agente ha completato l'ultimo turno"
              aria-label="Turno agente completato"
              style={{
                display: "inline-flex",
                alignItems: "center",
                color: "var(--color-signal)",
                marginRight: "4px",
              }}
            >
              <CheckCircle2 size={titleBarMetrics.iconSize} />
            </span>
          )}
          {gitBranch && terminalCount <= 4 && (
            <span
              style={{ ...TITLE_BAR_BRANCH, fontSize: titleBarMetrics.fontSize }}
              title={gitBranch}
            >
              <svg
                width={titleBarMetrics.iconSize}
                height={titleBarMetrics.iconSize}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {gitBranch}
            </span>
          )}

          {!hasExited && onToggleFocus && (
            <button
              type="button"
              onClick={handleToggleFocus}
              title={isFocused ? "Esci da Focus (Esc)" : "Focus mode"}
              aria-label={isFocused ? "Esci dalla modalità focus" : "Attiva modalità focus"}
              style={{
                ...TOOL_BTN_BASE,
                width: titleBarMetrics.buttonSize,
                height: titleBarMetrics.buttonSize,
                background: isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)",
                color: isFocused ? "#60a5fa" : "#a1a1aa",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.4)"
                  : "rgba(255,255,255,0.14)";
                e.currentTarget.style.color = isFocused ? "#93c5fd" : "#f4f4f5";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = isFocused ? "#60a5fa" : "#a1a1aa";
              }}
            >
              {isFocused ? (
                <Minimize2 size={titleBarMetrics.iconSize} />
              ) : (
                <Maximize2 size={titleBarMetrics.iconSize} />
              )}
            </button>
          )}

          {!hasExited && onClose &&
            (confirmClose ? (
              <div
                style={{
                  display: "flex",
                  gap: "4px",
                  alignItems: "center",
                  background: "rgba(12,12,12,0.96)",
                  borderRadius: "8px",
                  padding: "2px 4px",
                  border: "1px solid rgba(239,68,68,0.35)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "#ef4444",
                    padding: "0 4px",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  Chiudere?
                </span>
                <button
                  type="button"
                  onClick={handleConfirmClose}
                  title="Conferma chiusura"
                  aria-label="Conferma chiusura terminale"
                  style={{
                    ...TOOL_BTN_BASE,
                    width: titleBarMetrics.buttonSize,
                    height: titleBarMetrics.buttonSize,
                    background: "rgba(239,68,68,0.25)",
                    color: "#ef4444",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.45)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.25)";
                  }}
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={handleCancelClose}
                  title="Annulla"
                  aria-label="Annulla chiusura terminale"
                  style={{
                    ...TOOL_BTN_BASE,
                    width: titleBarMetrics.buttonSize,
                    height: titleBarMetrics.buttonSize,
                    background: "rgba(255,255,255,0.08)",
                    color: "#a1a1aa",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.15)";
                    e.currentTarget.style.color = "#f4f4f5";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                    e.currentTarget.style.color = "#a1a1aa";
                  }}
                >
                  <X size={titleBarMetrics.iconSize} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCloseClick}
                title="Chiudi terminale"
                aria-label="Chiudi terminale"
                style={{
                  ...TOOL_BTN_BASE,
                  width: titleBarMetrics.buttonSize,
                  height: titleBarMetrics.buttonSize,
                  background: "rgba(239,68,68,0.2)",
                  color: "#ef4444",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.2)";
                }}
              >
                <X size={titleBarMetrics.iconSize} />
              </button>
            ))}
        </div>
      </div>

      <div ref={containerRef} style={CONTAINER_STYLE} />

      {pendingNames.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: "8px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 15,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 14px",
            borderRadius: "10px",
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            color: "var(--color-primary)",
            backgroundColor: "rgba(232,93,4,0.12)",
            border: "1px solid rgba(232,93,4,0.25)",
            backdropFilter: "blur(8px)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "currentColor",
            boxShadow: "0 0 8px currentColor",
            }}
          />
          <span>
            usa la skill: {pendingNames.join(" e ")}
          </span>
        </div>
      )}

      {streamSyncFailed && !hasExited && (
        <div
          role="alert"
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-danger/35 bg-neutral-elevated/95 px-3 py-2 text-[11px] text-neutral-text shadow-xl"
        >
          <span>Sincronizzazione terminale interrotta.</span>
          <button
            type="button"
            onClick={handleRetryStreamSync}
            className="rounded-md border border-primary/40 px-2 py-1 font-semibold text-primary hover:bg-primary/10"
          >
            Riprova
          </button>
        </div>
      )}

      {hasExited && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(12,12,12,0.84)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            zIndex: 20,
            backdropFilter: "blur(8px)",
            padding: "24px",
          }}
        >
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.6 }}
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "13px",
              color: "#ef4444",
              fontWeight: 500,
              opacity: 0.9,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Terminale chiuso (exit code: {exitCode})
          </span>
          <button
            type="button"
            onClick={handleRestart}
            style={{
              minHeight: "40px",
              padding: "10px 20px",
              borderRadius: "10px",
              border: "1px solid rgba(232,93,4,0.4)",
              background: "rgba(232,93,4,0.12)",
              color: "#e85d04",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontSize: "14px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "10px",
              letterSpacing: "0.02em",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.25)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.7)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.12)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.4)";
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Riapri terminale
          </button>
        </div>
      )}
    </div>
  );
});
