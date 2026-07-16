import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { useTerminalStore } from "../../stores/terminalStore";
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
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(255,255,255,0.3)",
  selectionInactiveBackground: "rgba(255,255,255,0.15)",
  black: "#0c0c0c",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
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
}

// All pane styles gain display:flex + flexDirection:column so the title
// bar (above) and xterm container (below) stack vertically.
const ACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid #e85d04",
  overflow: "hidden",
  isolation: "isolate",
};

const FOCUSED_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid #3b82f6",
  overflow: "hidden",
  isolation: "isolate",
};

const INACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(255,255,255,0.10)",
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
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(239,68,68,0.3)",
  overflow: "hidden",
  isolation: "isolate",
};

const CONTAINER_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "#0c0c0c",
  overflow: "hidden",
};

const TITLE_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255,255,255,0.03)",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  userSelect: "none",
  overflow: "hidden",
};

function getTitleBarMetrics(terminalCount: number) {
  if (terminalCount <= 1) {
    return { height: 38, padding: "0 14px", fontSize: 13, buttonSize: 26, iconSize: 14, dotSize: 10 };
  }
  if (terminalCount === 2) {
    return { height: 34, padding: "0 12px", fontSize: 12, buttonSize: 24, iconSize: 13, dotSize: 9 };
  }
  if (terminalCount <= 4) {
    return { height: 31, padding: "0 11px", fontSize: 12, buttonSize: 23, iconSize: 12, dotSize: 8 };
  }
  return { height: 28, padding: "0 10px", fontSize: 11, buttonSize: 22, iconSize: 12, dotSize: 8 };
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
  gap: 6,
  flexShrink: 0,
  marginLeft: "auto",
  paddingLeft: 12,
};

const TOOL_BTN_BASE: React.CSSProperties = {
  width: "22px",
  height: "22px",
  borderRadius: "6px",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
  transition: "background 0.15s ease, color 0.15s ease",
  padding: 0,
};

function fitAndResizePty(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  autoScrollRef: React.MutableRefObject<boolean>,
) {
  const wasAtBottom = autoScrollRef.current;
  try {
    fitAddon.fit();
  } catch {
    // Fit can throw if container has zero size (hidden pane).
    return;
  }
  if (wasAtBottom) {
    term.scrollToBottom();
    autoScrollRef.current = true;
  }
  if (term.cols > 0 && term.rows > 0) {
    invoke("terminal_resize", {
      terminalId,
      cols: term.cols,
      rows: term.rows,
    }).catch(() => {});
  }
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
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  /** True while backend history is being written into xterm — drop live output to avoid wipe/race. */
  const rehydratingRef = useRef(false);
  const unsubOutputRef = useRef<(() => void) | null>(null);
  const unsubExitRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const exitCode = useTerminalStore(
    (s) => s.terminals[terminalId]?.exitCode ?? null,
  );
  const hasExited = exitCode !== null;

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
  }, [terminalId]);

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

    dataDisposableRef.current = term.onData((data) => {
      // The current prompt is being edited/executed. The next complete prompt
      // marks command completion even when it has the same CWD and text.
      atPowerShellPromptRef.current = false;
      const tid = terminalIdRef.current;
      if (!tid) return;
      const store = useTerminalStore.getState();
      const termState = store.terminals[tid];
      if (termState && termState.exitCode !== null) return;
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
      const buffer = term.buffer.active;
      autoScrollRef.current = buffer.viewportY >= buffer.baseY;
    });

    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
      unsubExitRef.current?.();
      unsubExitRef.current = null;
      dataDisposableRef.current?.dispose();
      dataDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [refreshTerminalContext, shell]);

  // 2. Spawn PTY + optional screen rehydrate + agent launch
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t && t.exitCode !== null) return;
    spawnedRef.current = true;

    // Rehydrate only when this FE entry was already live (workspace remount /
    // keep-alive). Skip on first open so we don't reset() a fresh stream.
    const shouldRehydrate = !!t?.spawned;

    const cols = Math.max(term.cols, 80);
    const rows = Math.max(term.rows, 24);

    (async () => {
      try {
        await invoke("terminal_spawn", {
          terminalId,
          shell,
          cwd,
          cols,
          rows,
        });
        useTerminalStore.getState().markSpawned(terminalId);

        // Carica il branch git all'avvio del terminale (primo mount + rehydrate).
        // Il backend ritorna Ok(Some("main")) → "main" | Ok(None) → null
        void refreshTerminalContext();

        if (shouldRehydrate) {
          rehydratingRef.current = true;
          try {
            const text = await invoke<string>("terminal_get_screen_text", {
              terminalId,
            });
            const termNow = xtermRef.current;

      if (text && text.trim().length > 0 && termNow) {
              // Chunk large dumps so multi-pane remount stays responsive.
              // Reset NON serve: xterm è appena stato creato (mount fresco),
              // buffer già pulito. reset() causa solo un frame nero extra.
              const CHUNK = 16_384;
              if (text.length <= CHUNK) {
                await new Promise<void>((resolve) => termNow.write(text, resolve));
              } else {
                await new Promise<void>((resolve) => {
                  let offset = 0;
                  const pump = () => {
                    if (!xtermRef.current) {
                      resolve();
                      return;
                    }
                    const end = Math.min(offset + CHUNK, text.length);
                    xtermRef.current.write(text.slice(offset, end), () => {
                      offset = end;
                      if (offset >= text.length) {
                        resolve();
                      } else {
                        requestAnimationFrame(pump);
                      }
                    });
                  };
                  requestAnimationFrame(pump);
                });
              }
              if (xtermRef.current) {
                xtermRef.current.scrollToBottom();
                autoScrollRef.current = true;
                const fitAddon = fitAddonRef.current;
                if (fitAddon) {
                  fitAndResizePty(
                    xtermRef.current,
                    fitAddon,
                    terminalId,
                    autoScrollRef,
                  );

                  // Solo per TUI agent: resize toggle (cols-1 → cols) per
                  // triggerare repaint completo nel processo figlio.
                  // Un cols/rows identico viene scartato dal backend
                  // (early-return in session.rs::resize) quindi non arriva
                  // alcun segnale di ridimensionamento. PowerShell / cmd
                  // non necessitano di questo toggle.
                  const term = xtermRef.current;
                  if (agentId && term.cols > 1 && term.rows > 0) {
                    invoke("terminal_resize", {
                      terminalId,
                      cols: term.cols - 1,
                      rows: term.rows,
                    }).catch(() => {});
                    requestAnimationFrame(() => {
                      invoke("terminal_resize", {
                        terminalId,
                        cols: term.cols,
                        rows: term.rows,
                      }).catch(() => {});
                    });
                  }

                  // Forza repaint xterm dopo reset()+write(): write() non
                  // sempre triggera il rendering (specie dopo reset() su
                  // terminale appena creato), e fitAddon.fit() è no-op se
                  // le dimensioni non cambiano. refresh(0, rows-1) garantisce
                  // che xterm ridisegni TUTTE le righe immediatamente.
                  if (term.rows > 0) {
                    term.refresh(0, term.rows - 1);
                  }
                }
              }
            }
          } catch {
            // Command unavailable — live stream only.
          } finally {
            rehydratingRef.current = false;
          }
        }
      } catch {
        spawnedRef.current = false;
        rehydratingRef.current = false;
      }

      if (agentId) {
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
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    // Hidden under another pane's focus mode — do not fit/resize to 0×0.
    if (focusModeActive && !isFocused) return;

    if (isActive || isFocused) {
      requestAnimationFrame(() => {
        fitAndResizePty(
          term,
          fitAddon,
          terminalId,
          autoScrollRef,
        );
        if (isActive || isFocused) {
          term.focus();
          term.clearSelection();
        }
      });
      invoke("terminal_set_active", { terminalId }).catch(() => {});
    }
  }, [isActive, isFocused, focusModeActive, terminalId]);

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
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    // Double rAF: wait for layout after grid CSS change.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAndResizePty(
          term,
          fitAddon,
          terminalId,
          autoScrollRef,
        );
        if (isFocused || isActive) term.focus();
      });
    });
  }, [isFocused, focusModeActive, isActive, terminalId]);

  // When leaving global focus mode, non-focused panes become visible again → fit.
  const prevFocusModeRef = useRef(focusModeActive);
  useEffect(() => {
    const leftFocusMode = prevFocusModeRef.current && !focusModeActive;
    prevFocusModeRef.current = focusModeActive;
    if (!leftFocusMode) return;

    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAndResizePty(
          term,
          fitAddon,
          terminalId,
          autoScrollRef,
        );
      });
    });
  }, [focusModeActive, terminalId]);

  // 4a. Output — shared bus + rAF batch (already coalesced in terminalEvents)
  useEffect(() => {
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, ({ data }) => {
      // While rehydrate runs, backend history is authoritative — applying live
      // chunks mid-reset would race and corrupt the buffer.
      if (rehydratingRef.current) return;
      const term = xtermRef.current;
      if (!term) return;
      term.write(new Uint8Array(data), () => {
        void syncContextFromPowerShellPrompt(term);
        // xterm writes asynchronously. Scrolling before this callback uses the
        // previous baseY and leaves the viewport one or more chunks behind.
        // Check the current value so a user scroll during a large agent output
        // is respected instead of being pulled back to the bottom.
        if (autoScrollRef.current) {
          term.scrollToBottom();
          autoScrollRef.current = true;
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
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      fitAndResizePty(
        term,
        fitAddon,
        terminalId,
        autoScrollRef,
      );
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
  }, [terminalId, focusModeActive, isFocused]);

  useTerminalInput(terminalId, containerRef, xtermRef);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const handleMouseDown = () => {
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
    e.dataTransfer.dropEffect = "copy";
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
        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.type === "skill" && data.name) {
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
            useSkillStore
              .getState()
              .addPendingDrop(terminalId, matchedSkill.name);
          }
        }
      } catch {
        // ignore
      }
    },
    [terminalId],
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

  return (
    <div
      style={{ ...outerStyle, ...dragOverlayStyle }}
      tabIndex={-1}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Title bar: workspace dot + name (left) | branch + buttons (right) */}
      <div style={titleBarStyle}>
        <div style={{ ...TITLE_BAR_LEFT, gap: titleBarMetrics.dotSize }}>
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

        <div style={TITLE_BAR_RIGHT}>
          {gitBranch && (
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
          <span style={{ fontSize: "14px", lineHeight: 1 }}>🎯</span>
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
            background: "rgba(12,12,12,0.92)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "20px",
            zIndex: 20,
            backdropFilter: "blur(4px)",
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
              fontSize: "14px",
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
              padding: "12px 28px",
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
