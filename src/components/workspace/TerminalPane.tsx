import { memo, useEffect, useRef, useCallback } from "react";
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
  borderRadius: "4px",
  border: "1px solid #e85d04",
  overflow: "hidden" as const,
};

const INACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "4px",
  border: "1px solid rgba(255,255,255,0.06)",
  overflow: "hidden" as const,
  cursor: "pointer" as const,
};

const EXITED_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "4px",
  border: "1px solid rgba(239,68,68,0.3)",
  overflow: "hidden" as const,
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

  // Leggi lo stato exit dallo store
  const exitCode = useTerminalStore((s) => s.terminals[terminalId]?.exitCode ?? null);
  const hasExited = exitCode !== null;

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

    return () => {
      unlistenRef.current?.();
      unlistenExitRef.current?.();
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
      });

      invoke("terminal_set_active", { terminalId }).catch(() => {});
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
        xtermRef.current?.write(new Uint8Array(data));
      });
      if (!cancelled) {
        unlistenRef.current?.();
        unlistenRef.current = unlisten;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  // 4b. Listener terminal-exited — aggiorna lo store
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const unlisten = await listen<TerminalExited>("terminal-exited", (event) => {
        if (cancelled) return;
        const { terminalId: tid, exitCode } = event.payload;
        if (tid !== terminalId) return;
        useTerminalStore.getState().markExited(tid, exitCode);
      });
      if (!cancelled) {
        unlistenExitRef.current?.();
        unlistenExitRef.current = unlisten;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  // 5. Resize handler — sempre attivo
  useEffect(() => {
    const handleResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      fitAddon.fit();
      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows })
        .catch(() => {});
    };

    const raf = requestAnimationFrame(() => handleResize());

    window.addEventListener("resize", handleResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
    };
  }, [terminalId]);

  useTerminalInput(terminalId, containerRef);

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

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose?.(terminalId);
  }, [terminalId, onClose]);

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

      {/* Pulsante chiudi — visibile in alto a destra */}
      {onClose && !hasExited && (
        <button
          onClick={handleClose}
          style={CLOSE_BTN_STYLE}
          title="Chiudi terminale"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(239,68,68,0.35)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(239,68,68,0.2)";
          }}
        >
          ✕
        </button>
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
            gap: "12px",
            zIndex: 20,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "13px",
              color: "#ef4444",
              fontWeight: 500,
            }}
          >
            Terminale chiuso (exit code: {exitCode})
          </span>
          <button
            onClick={handleRestart}
            style={{
              padding: "8px 20px",
              borderRadius: "8px",
              border: "1px solid rgba(232,93,4,0.4)",
              background: "rgba(232,93,4,0.15)",
              color: "#e85d04",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontSize: "13px",
              fontWeight: 600,
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.15)";
            }}
          >
            🔄 Riapri terminale
          </button>
        </div>
      )}
    </div>
  );
});
