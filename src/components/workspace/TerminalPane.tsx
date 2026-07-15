import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore } from "../../stores/skillStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import {
  subscribeTerminalExit,
  subscribeTerminalOutput,
} from "../../lib/terminalEvents";
import { encodeForPty } from "../../lib/ptyWrite";
import "xterm/css/xterm.css";

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
  isActive: boolean;
  /** This pane is the focus-mode target. */
  isFocused?: boolean;
  /** Any pane is currently in focus mode (grid collapsed). */
  focusModeActive?: boolean;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
  onToggleFocus?: (id: string) => void;
}

const ACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid #e85d04",
  overflow: "hidden",
  isolation: "isolate",
};

const INACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
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
  position: "absolute",
  inset: 0,
  background: "#0c0c0c",
  overflow: "hidden",
};

const TOOLBAR_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  zIndex: 10,
  display: "flex",
  gap: "6px",
  alignItems: "center",
};

const TOOL_BTN_BASE: React.CSSProperties = {
  width: "28px",
  height: "28px",
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

function fitAndResizePty(
  term: Terminal,
  fitAddon: FitAddon,
  terminalId: string,
  autoScrollRef: React.MutableRefObject<boolean>,
  programmaticScrollRef: React.MutableRefObject<boolean>,
) {
  const wasAtBottom = autoScrollRef.current;
  try {
    fitAddon.fit();
  } catch {
    // Fit can throw if container has zero size (hidden pane).
    return;
  }
  if (wasAtBottom) {
    programmaticScrollRef.current = true;
    term.scrollToBottom();
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
  isActive,
  isFocused = false,
  focusModeActive = false,
  onActivate,
  onClose,
  onToggleFocus,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const unsubOutputRef = useRef<(() => void) | null>(null);
  const unsubExitRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  const programmaticScrollRef = useRef(false);
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

  const [confirmClose, setConfirmClose] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClose]);

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
      const tid = terminalIdRef.current;
      if (!tid) return;
      const store = useTerminalStore.getState();
      const termState = store.terminals[tid];
      if (termState && termState.exitCode !== null) return;
      invoke("terminal_write", {
        terminalId: tid,
        data: encodeForPty(data),
      }).catch(() => {});
    });

    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
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
  }, []);

  // 2. Spawn PTY + optional screen rehydrate + agent launch
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t && t.exitCode !== null) return;
    spawnedRef.current = true;

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

        // Rehydrate scrollback + screen if the backend PTY was kept alive
        // (workspace switch). Backend caps history at ~1000 lines.
        try {
          const text = await invoke<string>("terminal_get_screen_text", {
            terminalId,
          });
          const termNow = xtermRef.current;
          if (text && text.trim().length > 0 && termNow) {
            termNow.reset();
            // Chunk large dumps so a single write does not freeze the UI
            // when many panes rehydrate at once after a workspace switch.
            const CHUNK = 16_384;
            if (text.length <= CHUNK) {
              termNow.write(text);
            } else {
              await new Promise<void>((resolve) => {
                let offset = 0;
                const pump = () => {
                  if (!xtermRef.current) {
                    resolve();
                    return;
                  }
                  const end = Math.min(offset + CHUNK, text.length);
                  xtermRef.current.write(text.slice(offset, end));
                  offset = end;
                  if (offset >= text.length) {
                    resolve();
                  } else {
                    requestAnimationFrame(pump);
                  }
                };
                requestAnimationFrame(pump);
              });
            }
            if (xtermRef.current) {
              programmaticScrollRef.current = true;
              xtermRef.current.scrollToBottom();
            }
          }
        } catch {
          // New session or command unavailable — ignore.
        }
      } catch {
        spawnedRef.current = false;
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
  }, [terminalId, shell, cwd, agentId]);

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
          programmaticScrollRef,
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
          programmaticScrollRef,
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
          programmaticScrollRef,
        );
      });
    });
  }, [focusModeActive, terminalId]);

  // 4a. Output — shared bus + rAF batch (already coalesced in terminalEvents)
  useEffect(() => {
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, ({ data }) => {
      const term = xtermRef.current;
      if (!term) return;
      term.write(new Uint8Array(data));
      if (autoScrollRef.current) {
        programmaticScrollRef.current = true;
        term.scrollToBottom();
      }
    });
    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
    };
  }, [terminalId]);

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
        programmaticScrollRef,
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

  const handleRestart = useCallback(async () => {
    try {
      await invoke("terminal_reopen", {
        terminalId,
        shell,
        cwd,
      });
      useTerminalStore.getState().markSpawned(terminalId);
      spawnedRef.current = true;
      xtermRef.current?.reset();
    } catch (err) {
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, shell, cwd]);

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
    : isActive || isFocused
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
      <div ref={containerRef} style={CONTAINER_STYLE} />

      {/* Toolbar: Focus + Close */}
      {!hasExited && (
        <div style={TOOLBAR_STYLE}>
          {onToggleFocus && (
            <button
              type="button"
              onClick={handleToggleFocus}
              title={isFocused ? "Esci da Focus (Esc)" : "Focus mode"}
              style={{
                ...TOOL_BTN_BASE,
                background: isFocused
                  ? "rgba(232,93,4,0.28)"
                  : "rgba(255,255,255,0.08)",
                color: isFocused ? "#e85d04" : "#a1a1aa",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(232,93,4,0.4)"
                  : "rgba(255,255,255,0.14)";
                e.currentTarget.style.color = isFocused ? "#ff7b00" : "#f4f4f5";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(232,93,4,0.28)"
                  : "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = isFocused ? "#e85d04" : "#a1a1aa";
              }}
            >
              {isFocused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}

          {onClose &&
            (confirmClose ? (
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  alignItems: "center",
                  background: "rgba(12,12,12,0.96)",
                  borderRadius: "10px",
                  padding: "4px 6px",
                  border: "1px solid rgba(239,68,68,0.35)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                }}
              >
                <span
                  style={{
                    fontSize: "12px",
                    color: "#ef4444",
                    padding: "0 6px",
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
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCloseClick}
                title="Chiudi terminale"
                style={{
                  ...TOOL_BTN_BASE,
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
                <X size={14} />
              </button>
            ))}
        </div>
      )}

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
