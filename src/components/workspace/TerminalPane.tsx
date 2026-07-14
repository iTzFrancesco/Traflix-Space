import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { useTerminalStore } from "../../stores/terminalStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import type { TerminalOutput, TerminalExited } from "../terminal/types";
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
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
}

const ACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid #e85d04",
  overflow: "hidden" as const,
  isolation: "isolate" as const,
};

const INACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(255,255,255,0.10)",
  overflow: "hidden" as const,
  cursor: "pointer" as const,
  isolation: "isolate" as const,
};

const EXITED_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(239,68,68,0.3)",
  overflow: "hidden" as const,
  isolation: "isolate" as const,
};

const CLOSE_BTN_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "6px",
  right: "6px",
  width: "24px",
  height: "24px",
  borderRadius: "6px",
  border: "none",
  background: "rgba(239,68,68,0.2)",
  color: "#ef4444",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "14px",
  lineHeight: 1,
  zIndex: 10,
  transition: "all 0.15s ease",
};

const CONTAINER_STYLE = {
  position: "absolute" as const,
  inset: 0,
  background: "#0c0c0c",
  overflow: "hidden" as const,
};

export const TerminalPane = memo(function TerminalPane({
  terminalId, shell, cwd, title: _title, agentId, isActive, onActivate, onClose,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);

  // Leggi lo stato exit dallo store
  const exitCode = useTerminalStore((s) => s.terminals[terminalId]?.exitCode ?? null);
  const hasExited = exitCode !== null;

  // Ref per onClose (aggiornato senza triggerare re-render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Auto-chiusura quando il terminale esce (shell exit)
  useEffect(() => {
    if (!hasExited) return;
    const timer = setTimeout(() => {
      onCloseRef.current?.(terminalId);
    }, 1500);
    return () => clearTimeout(timer);
  }, [hasExited, terminalId]);

  // Stato conferma chiusura
  const [confirmClose, setConfirmClose] = useState(false);

  // Auto-annulla conferma dopo 3s
  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClose]);

  // Escape annulla conferma
  useEffect(() => {
    if (!confirmClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmClose(false);
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [confirmClose]);

  // 1. Crea xterm al mount, aprilo nel container (sempre nel DOM), distruggi al unmount
  useEffect(() => {
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      scrollback: 500,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
    }

    term.onData((data) => {
      const tid = terminalIdRef.current;
      if (!tid) return;
      // Non scrivere se il terminale è uscito
      const store = useTerminalStore.getState();
      const termState = store.terminals[tid];
      if (termState && termState.exitCode !== null) return;
      invoke("terminal_write", {
        terminalId: tid,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(() => {});
    });

    // Auto-scroll: traccia se l'utente è incollato al fondo
    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      const buffer = term.buffer.active;
      autoScrollRef.current = buffer.viewportY >= buffer.baseY;
    });

    return () => {
      unlistenRef.current?.();
      unlistenExitRef.current?.();
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 2. Spawn PTY + launch agente al mount (senza click)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    // Non respawnare se è uscito
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t && t.exitCode !== null) return;
    spawnedRef.current = true;

    invoke("terminal_spawn", {
      terminalId, shell, cwd, cols: Math.max(term.cols, 80), rows: Math.max(term.rows, 24),
    }).catch(() => {});

    if (agentId) {
      const store = useTerminalStore.getState();
      const terminal = store.terminals[terminalId];
      if (!terminal?.agentLaunched) {
        store.markAgentLaunched(terminalId);
        agentLaunchQueue.enqueue(terminalId, agentId);
      }
    }
  }, [terminalId, shell, cwd, agentId]);

  // 3. Focus + active state quando cliccato
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    if (isActive) {
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
        term.clearSelection();
        // Forza repaint completo per eliminare artefatti visivi
        term.refresh(0, term.rows - 1);
      });

      invoke("terminal_set_active", { terminalId }).catch(() => {});
    } else {
      // Quando diventa inattivo: forza repaint pulito per evitare ghost text
      requestAnimationFrame(() => {
        term.refresh(0, term.rows - 1);
      });
    }
  }, [isActive, terminalId]);

  // 4a. Listener output terminale — sempre attivo
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const unlisten = await listen<TerminalOutput>("terminal-output", (event) => {
        if (cancelled) return;
        const { terminalId: tid, data } = event.payload;
        if (tid !== terminalId) return;
        const term = xtermRef.current;
        term?.write(new Uint8Array(data));
        if (autoScrollRef.current && term) {
          term.scrollToBottom();
        }
      });
      if (cancelled) {
        // Component già smontato/effetto già pulito — unlisten subito
        unlisten();
      } else {
        unlistenRef.current?.();
        unlistenRef.current = unlisten;
      }
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [terminalId]);

  // 4b. Listener terminal-exited — aggiorna lo store + auto-close
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const unlisten = await listen<TerminalExited>("terminal-exited", (event) => {
        if (cancelled) return;
        const { terminalId: tid, exitCode } = event.payload;
        if (tid !== terminalId) return;
        useTerminalStore.getState().markExited(tid, exitCode);
      });
      if (cancelled) {
        unlisten();
      } else {
        unlistenExitRef.current?.();
        unlistenExitRef.current = unlisten;
      }
    })();

    return () => {
      cancelled = true;
      unlistenExitRef.current?.();
      unlistenExitRef.current = null;
    };
  }, [terminalId]);

  // 5. Resize handler — ResizeObserver + rAF per throttling
  // Usa ResizeObserver invece di window.resize per catturare cambi layout griglia
  useEffect(() => {
    const handleResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      fitAddon.fit();
      if (autoScrollRef.current) {
        term.scrollToBottom();
      }
      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows })
        .catch(() => {});
    };

    const container = containerRef.current;
    if (!container) return;

    // Initial fit al mount (serve anche come resize iniziale)
    const raf = requestAnimationFrame(() => handleResize());

    // ResizeObserver: cattura qualsiasi variazione dimensionale del container
    let observerRaf: number | null = null;
    const observer = new ResizeObserver(() => {
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
      observerRaf = requestAnimationFrame(() => handleResize());
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
      observer.disconnect();
    };
  }, [terminalId]);

  useTerminalInput(terminalId, containerRef, xtermRef);

  // Attiva il terminale al click — in capture phase per bypassare stopPropagation di xterm
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
    return () => el.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, [terminalId, onActivate]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(true);
  }, []);

  const handleConfirmClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
    onClose?.(terminalId);
  }, [terminalId, onClose]);

  const handleCancelClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      await invoke("terminal_reopen", {
        terminalId,
        shell,
        cwd,
      });
      useTerminalStore.getState().markSpawned(terminalId);
      spawnedRef.current = true;
    } catch (err) {
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, shell, cwd]);

  const outerStyle = hasExited
    ? EXITED_STYLE
    : (isActive ? ACTIVE_STYLE : INACTIVE_STYLE);

  return (
    <div
      style={outerStyle}
      tabIndex={-1}
    >
      {/* Container xterm — sempre presente nel DOM */}
      <div ref={containerRef} style={CONTAINER_STYLE} />

      {/* Pulsante chiudi / conferma chiusura — in alto a destra */}
      {onClose && !hasExited && (
        confirmClose ? (
          <div
            style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              zIndex: 10,
              display: "flex",
              gap: "4px",
              alignItems: "center",
              background: "rgba(12,12,12,0.96)",
              borderRadius: "8px",
              padding: "3px 4px",
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
              onClick={handleConfirmClose}
              title="Conferma chiusura"
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "6px",
                border: "none",
                background: "rgba(239,68,68,0.25)",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                transition: "all 0.12s ease",
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
              onClick={handleCancelClose}
              title="Annulla"
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "6px",
                border: "none",
                background: "rgba(255,255,255,0.08)",
                color: "#a1a1aa",
                cursor: "pointer",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                transition: "all 0.12s ease",
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
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={handleCloseClick}
            style={CLOSE_BTN_STYLE}
            title="Chiudi terminale — click per conferma"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.2)";
            }}
          >
            ✕
          </button>
        )
      )}

      {/* Overlay terminale uscito */}
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
            gap: "16px",
            zIndex: 20,
            backdropFilter: "blur(4px)",
          }}
        >
          {/* Icona terminale spento */}
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
              opacity: 0.85,
            }}
          >
            Terminale chiuso (exit code: {exitCode})
          </span>

          <button
            onClick={handleRestart}
            style={{
              padding: "10px 24px",
              borderRadius: "8px",
              border: "1px solid rgba(232,93,4,0.4)",
              background: "rgba(232,93,4,0.12)",
              color: "#e85d04",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontSize: "13px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "8px",
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
            {/* SVG restart custom */}
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
