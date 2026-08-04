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
} from "../../lib/terminalEvents";
import { encodeForPty } from "../../lib/ptyWrite";
import { getWorkspaceColor } from "../../lib/workspaceColors";
import { AGENTS } from "../../lib/agents";
import { findCurrentPowerShellPrompt } from "../../lib/powerShellPrompt";
import { invokeWithTimeout } from "../../lib/timeout";
import type { TerminalRehydrateState } from "../terminal/types";
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
  terminalId?: string;
  terminal_id?: string;
  cwd?: string;
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
  const offsetFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
  const followsOutput = offsetFromBottom === 0;
  autoScrollRef.current = followsOutput;
  scrollPositionRef.current = { followsOutput, offsetFromBottom };
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
) {
  const { followsOutput, offsetFromBottom } = scrollPositionRef.current;
  if (followsOutput) {
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
    autoScrollRef.current = false;
    return;
  }

  // `baseY` changes when xterm reflows during a fit. Restoring a distance from
  // the live bottom keeps the same reading context and, crucially, never turns
  // a layout change into a jump to the first line of the buffer.
  programmaticScrollTargetRef.current = -1;
  term.scrollToLine(Math.max(0, term.buffer.active.baseY - offsetFromBottom));
  programmaticScrollTargetRef.current = term.buffer.active.viewportY;
  captureScrollPosition(term, autoScrollRef, scrollPositionRef);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isTerminalExitedError(error: unknown): boolean {
  return String(error).toLowerCase().includes("terminal-exited");
}

/** Measure the mounted pane before taking a backend snapshot or resizing a PTY. */
async function syncMeasuredPtySize(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  skipHiddenPane: boolean,
  resizeStateRef: React.MutableRefObject<PtyResizeState>,
) {
  if (skipHiddenPane) return;

  // The workspace grid has just mounted. Two frames let the grid tracks and
  // the xterm canvas settle before FitAddon reads its cell dimensions.
  await waitForAnimationFrame();
  await waitForAnimationFrame();
  if (!term.element?.isConnected) return;
  const rect = term.element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  try {
    fitAddon.fit();
  } catch {
    return;
  }
  if (term.cols <= 0 || term.rows <= 0) return;

  await enqueuePtyResize(resizeStateRef, terminalId, term.cols, term.rows);
}

function fitAndResizePty(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  autoScrollRef: React.MutableRefObject<boolean>,
  scrollPositionRef: React.MutableRefObject<TerminalScrollPosition>,
  programmaticScrollTargetRef: React.MutableRefObject<number | null>,
  resizeStateRef: React.MutableRefObject<PtyResizeState>,
) {
  // xterm can emit internal scroll events while parsing output. Snapshot the
  // live viewport just before reflow so a resize never restores stale state.
  if (term.buffer.active.baseY > 0 || scrollPositionRef.current.followsOutput) {
    captureScrollPosition(term, autoScrollRef, scrollPositionRef);
  }
  const positionBeforeFit = scrollPositionRef.current;
  const viewportAnchor = positionBeforeFit.followsOutput
    ? null
    : captureViewportAnchor(term);
  try {
    fitAddon.fit();
  } catch {
    // Fit can throw if container has zero size (hidden pane).
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
    );
  } else if (term.buffer.active.baseY > 0) {
    // xterm normally keeps ydisp stable during reflow. If a focus transition
    // changes both columns and rows, however, its row arithmetic can still
    // land at the first line. Restore the visible content anchor in that
    // case, then capture the new bottom-relative position for later remounts.
    restoreViewportAnchor(term, viewportAnchor, programmaticScrollTargetRef);
    captureScrollPosition(term, autoScrollRef, scrollPositionRef);
  } else {
    // There is no scrollback yet. Preserve the reader intent until rehydrate
    // or output creates a scrollable buffer.
    scrollPositionRef.current = positionBeforeFit;
    autoScrollRef.current = false;
    programmaticScrollTargetRef.current = null;
  }
  if (term.cols > 0 && term.rows > 0) {
    void enqueuePtyResize(resizeStateRef, terminalId, term.cols, term.rows).catch(() => {});
  }
}

interface PtyResizeState {
  pending: {
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
  cols: number,
  rows: number,
): Promise<void> {
  const state = stateRef.current;
  const promise = new Promise<void>((resolve, reject) => {
    const waiters = state.pending?.waiters ?? [];
    state.pending = {
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
  /** True while backend history is being written into xterm — drop live output to avoid wipe/race. */
  const rehydratingRef = useRef(false);
  /** PTY chunks received around the backend snapshot; replayed after filtering. */
  const queuedRehydrateOutputRef = useRef<Array<{
    sequence: number;
    data: Uint8Array;
  }>>([]);
  /** Snapshot watermark; chunks at or below it are already in the snapshot. */
  const rehydrateWatermarkRef = useRef<number | null>(null);
  const unsubOutputRef = useRef<(() => void) | null>(null);
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
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const exitCode = useTerminalStore(
    (s) => s.terminals[terminalId]?.exitCode ?? null,
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
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const currentCwdRef = useRef(cwd);
  const contextRequestRef = useRef(0);
  const atPowerShellPromptRef = useRef(false);

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
      fitAndResizePty(
        term,
        fitAddon,
        terminalId,
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollTargetRef,
        ptyResizeStateRef,
      );
    };

    schedule.raf = requestAnimationFrame(run);
  }, [focusModeActive, isFocused, terminalId]);

  useEffect(() => {
    currentCwdRef.current = cwd;
    setCurrentCwd(cwd);
  }, [cwd]);

  const refreshTerminalContext = useCallback(async () => {
    const requestId = ++contextRequestRef.current;
    try {
      const context = await invoke<TerminalContext>("terminal_get_context", {
        terminalId,
      });
      if (requestId !== contextRequestRef.current) return;
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

    try {
      const context = sameWindowsPath(prompt.cwd, currentCwdRef.current)
        ? await invoke<TerminalContext>("terminal_get_context", { terminalId })
        : await invoke<TerminalContext>("terminal_sync_cwd", {
            terminalId,
            cwd: prompt.cwd,
          });
      if (requestId !== contextRequestRef.current) return;
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
      if (termState && termState.exitCode !== null) return;
      useTerminalStore.getState().markAgentInput(tid);
      const write = invoke("terminal_write", {
        terminalId: tid,
        data: encodeForPty(data),
      });

      // PowerShell is refreshed only after its next completed prompt, when
      // commands such as `git checkout` have actually finished. Other shells
      // retain the Enter fallback because their prompt format is unknown.
      if (
        !isPowerShell(shell) &&
        (data.includes("\r") || data.includes("\n"))
      ) {
        write.then(() => void refreshTerminalContext()).catch(() => {});
      } else {
        write.catch(() => {});
      }
    });

    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      const programmaticTarget = programmaticScrollTargetRef.current;
      if (programmaticTarget !== null) {
        if (
          programmaticTarget === -1 ||
          programmaticTarget === term.buffer.active.viewportY
        ) {
          if (programmaticTarget !== -1) {
            programmaticScrollTargetRef.current = null;
          }
          return;
        }
        // A different y can arrive after fit/scrollToLine because xterm emits
        // internal viewport updates while layout settles. Only an explicit
        // wheel/key/scrollbar intent is allowed to override the restore.
        if (!userScrollIntentRef.current) return;
        programmaticScrollTargetRef.current = null;
      }
      // Every non-programmatic xterm scroll event is authoritative. Output
      // can change baseY while a reader is in history, and ignoring these
      // events while writes are pending loses the real viewport under load.
      captureScrollPosition(term, autoScrollRef, scrollPositionRef);
      userScrollIntentRef.current = false;
    });

    let disposed = false;
    const scheduleUserScrollCapture = () => {
      requestAnimationFrame(() => {
        if (disposed || xtermRef.current !== term) return;
        captureScrollPosition(term, autoScrollRef, scrollPositionRef);
        userScrollIntentRef.current = false;
      });
    };
    const onWheel = (event: WheelEvent) => {
      userScrollIntentRef.current = true;
      // Stop a queued output callback from snapping back before the browser
      // applies this upward wheel movement.
      if (event.deltaY < 0) {
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
      autoScrollRef.current = false;
      scrollPositionRef.current = {
        followsOutput: false,
        offsetFromBottom: Math.max(1, scrollPositionRef.current.offsetFromBottom),
      };
    };
    const container = containerRef.current;
    container?.addEventListener("wheel", onWheel, { passive: false, capture: true });
    container?.addEventListener("keydown", onKeyDown, { capture: true });
    container?.addEventListener("pointerdown", onPointerDown, { capture: true });

    return () => {
      disposed = true;
      if (scrollPositionRef.current.followsOutput || term.buffer.active.baseY > 0) {
        captureScrollPosition(term, autoScrollRef, scrollPositionRef);
      }
      useTerminalStore.getState().saveScrollPosition(
        terminalIdRef.current,
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
      if (fitScheduleRef.current.raf !== null) {
        cancelAnimationFrame(fitScheduleRef.current.raf);
        fitScheduleRef.current.raf = null;
        fitScheduleRef.current.remainingFrames = 0;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [refreshTerminalContext, shell, terminalId]);

  // 2. Spawn PTY + optional screen rehydrate + agent launch
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t && t.exitCode !== null) return;
    spawnedRef.current = true;

    // Always take a backend snapshot. On first open the shell can emit its
    // prompt before the React event listener is attached; treating the
    // parser as authoritative closes that initial-output race too.
    // Set this before any await: terminal_spawn and terminal_resize can
    // trigger output from a live TUI while the new xterm is still empty.
    rehydratingRef.current = true;
    rehydrateWatermarkRef.current = null;

    const cols = Math.max(term.cols, 80);
    const rows = Math.max(term.rows, 24);
    let spawnSucceeded = false;
    const replayQueuedOutput = async () => {
      while (queuedRehydrateOutputRef.current.length > 0) {
        const next = queuedRehydrateOutputRef.current.shift();
        const currentTerm = xtermRef.current;
        if (!next || !currentTerm) return;
        const watermark = rehydrateWatermarkRef.current;
        if (watermark !== null && next.sequence <= watermark) continue;
        await new Promise<void>((resolve) => currentTerm.write(next.data, resolve));
      }
    };
    const restoreSnapshot = async () => {
      const rehydrateState = await invoke<TerminalRehydrateState>("terminal_get_screen_text", {
        terminalId,
      });
      rehydrateWatermarkRef.current = rehydrateState.outputSequence;
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
      if (rehydrateState.state.length > 0) {
        await new Promise<void>((resolve) =>
          termNow.write(new Uint8Array(rehydrateState.state), resolve),
        );
      }
      await replayQueuedOutput();
      restoreScrollPosition(
        termNow,
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollTargetRef,
      );
      if (termNow.rows > 0) {
        termNow.refresh(0, termNow.rows - 1);
      }
    };

    (async () => {
      try {
        await invoke("terminal_spawn", {
          terminalId,
          shell,
          cwd,
          cols,
          rows,
          workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
        });
        spawnSucceeded = true;
        useTerminalStore.getState().markSpawned(terminalId);

        // Carica il branch git all'avvio del terminale (primo mount + rehydrate).
        // Il backend ritorna Ok(Some("main")) → "main" | Ok(None) → null
        void refreshTerminalContext();

        try {
            const fitAddon = fitAddonRef.current;
            if (fitAddon) {
              await syncMeasuredPtySize(
                term,
                fitAddon,
                terminalId,
                focusModeActive && !isFocused,
                ptyResizeStateRef,
              );
            }
            await restoreSnapshot();
            // The snapshot and every queued post-snapshot chunk are rendered.
            // Stop intercepting output before the context lookup below; that
            // lookup is unrelated and must never strand new PTY bytes.
            rehydratingRef.current = false;
            if (xtermRef.current) {
              await syncContextFromPowerShellPrompt(xtermRef.current);
            }
          } catch {
            // If snapshot/resize fails, never discard live output captured
            // while the backend was being queried.
            await replayQueuedOutput();
          } finally {
            rehydratingRef.current = false;
            rehydrateWatermarkRef.current = null;
          }
      } catch (error) {
        if (isTerminalExitedError(error)) {
          // The backend keeps the dead parser so the last screen can still be
          // displayed even when the pane was unmounted at exit time.
          rehydratingRef.current = true;
          rehydrateWatermarkRef.current = null;
          try {
            await restoreSnapshot();
          } catch {
            await replayQueuedOutput();
          }
          useTerminalStore.getState().markExited(terminalId, 0);
          rehydratingRef.current = false;
        } else {
          await replayQueuedOutput();
        }
        spawnedRef.current = false;
        rehydratingRef.current = false;
        rehydrateWatermarkRef.current = null;
      }

      if (agentId && spawnSucceeded) {
        const store = useTerminalStore.getState();
        const terminal = store.terminals[terminalId];
        if (!terminal?.agentLaunched) {
          store.markAgentLaunched(terminalId);
          agentLaunchQueue.enqueue(terminalId, agentId);
        }
      }
    })();
  }, [terminalId, shell, cwd, agentId, refreshTerminalContext]);

  // 2b. Listen for CWD changes from backend (cd command detected) → refresh git branch.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<TerminalCwdChangedPayload | string>("terminal-cwd-changed", (event) => {
      const payload = event.payload;
      const changedTerminalId =
        typeof payload === "string"
          ? payload
          : payload.terminalId ?? payload.terminal_id;
      if (changedTerminalId === terminalId) {
        if (typeof payload !== "string" && payload.cwd) {
          currentCwdRef.current = payload.cwd;
          setCurrentCwd(payload.cwd);
        }
        console.log(`[branch] cwd-changed event for ${terminalId}, re-fetching`);
        void refreshTerminalContext();
      }
    }).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, [terminalId, refreshTerminalContext]);

  // 3. Active focus + backend active flag (skip heavy refresh when hidden in focus mode)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Hidden under another pane's focus mode — do not fit/resize to 0×0.
    if (focusModeActive && !isFocused) return;

    if (isActive || isFocused) {
      requestAnimationFrame(() => {
        scheduleFitAndResize();
        if (isActive || isFocused) {
          term.focus();
          term.clearSelection();
        }
      });
      invoke("terminal_set_active", { terminalId }).catch(() => {});
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

  // 4a. Output — shared bus + rAF batch (already coalesced in terminalEvents)
  useEffect(() => {
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, (payload) => {
      // While rehydrate runs, backend history is authoritative — applying live
      // chunks mid-reset would race and corrupt the buffer. Keep them and
      // replay them after the snapshot so a working agent never loses output.
      if (rehydratingRef.current) {
        const chunks = payload.chunks ?? [{
          sequence: payload.sequence,
          data: new Uint8Array(payload.data),
        }];
        const watermark = rehydrateWatermarkRef.current;
        for (const chunk of chunks) {
          if (watermark === null || chunk.sequence > watermark) {
            queuedRehydrateOutputRef.current.push(chunk);
          }
        }
        return;
      }
      const { data } = payload;
      const term = xtermRef.current;
      if (!term) return;
      term.write(new Uint8Array(data), () => {
        void syncContextFromPowerShellPrompt(term);
        // xterm writes asynchronously. Scrolling before this callback uses the
        // previous baseY and leaves the viewport one or more chunks behind.
        // Check the current value so a user scroll during a large agent output
        // is respected instead of being pulled back to the bottom.
        if (autoScrollRef.current) {
          scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
          if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
            restoreScrollPosition(
              term,
              autoScrollRef,
              scrollPositionRef,
              programmaticScrollTargetRef,
            );
          }
        } else {
          // Output changes baseY while a reader stays at an older line. Record
          // the new relative offset so a later resize/remount returns here.
          captureScrollPosition(term, autoScrollRef, scrollPositionRef);
        }
      });
    });
    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
    };
  }, [terminalId, syncContextFromPowerShellPrompt]);

  // 4b. Exit
  useEffect(() => {
    unsubExitRef.current?.();
    unsubExitRef.current = subscribeTerminalExit(
      terminalId,
      ({ terminalId: tid, exitCode: code }) => {
        useTerminalStore.getState().markExited(tid, code);
      },
    );
    return () => {
      unsubExitRef.current?.();
      unsubExitRef.current = null;
    };
  }, [terminalId]);

  // 5. ResizeObserver — skip when this pane is hidden under focus mode
  useEffect(() => {
    const handleResize = () => {
      if (focusModeActive && !isFocused) return;
      scheduleFitAndResize();
    };

    const container = containerRef.current;
    if (!container) return;

    let lastResizeTime = 0;
    const RESIZE_THROTTLE_MS = 100;

    const raf = requestAnimationFrame(() => {
      lastResizeTime = Date.now();
      handleResize();
    });

    let observerRaf: number | null = null;
    const observer = new ResizeObserver(() => {
      if (focusModeActive && !isFocused) return;
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
      observerRaf = requestAnimationFrame(() => {
        const now = Date.now();
        if (now - lastResizeTime >= RESIZE_THROTTLE_MS) {
          lastResizeTime = now;
          handleResize();
        }
      });
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
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
  const terminalWorkspaceId = useTerminalStore(
    (s) => s.terminals[terminalId]?.workspaceId,
  );
  const agentStatus = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentStatus ?? "idle",
  );
  const agentAttentionRequired = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentAttentionRequired ?? false,
  );
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
    if (trimmed) {
      useTerminalStore.getState().renameTerminal(terminalId, trimmed);
    }
    setEditing(false);
  }, [editValue, terminalId]);

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
      await invoke("terminal_reopen", {
        terminalId,
        shell,
        cwd: currentCwd,
        cols: xtermRef.current?.cols ?? 80,
        rows: xtermRef.current?.rows ?? 24,
        workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
      });
      useTerminalStore.getState().markSpawned(terminalId);
      spawnedRef.current = true;
      xtermRef.current?.reset();
    } catch (err) {
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, shell, currentCwd]);

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
            useTerminalStore.getState().markAgentInput(terminalId);
            useSkillStore.getState().addPendingDrop(terminalId, data.name);
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
            useTerminalStore.getState().markAgentInput(terminalId);
            useSkillStore
              .getState()
              .addPendingDrop(terminalId, matchedSkill.name);
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
            usa{" "}
            {pendingNames.length === 1
              ? `la skill ${pendingNames[0]}`
              : pendingNames.length === 2
                ? `le skill ${pendingNames.join(" e ")}`
                : `le skill ${pendingNames.slice(0, -1).join(", ")} e ${pendingNames[pendingNames.length - 1]}`}
          </span>
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
