import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TerminalSnapshot } from "../terminal/TerminalSnapshot";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import type { TerminalOutput, FrameSnapshot } from "../terminal/types";
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

function renderSnapshotToTerm(term: Terminal, snapshot: FrameSnapshot) {
  term.reset();
  if (!snapshot.cells) return;
  for (let r = 0; r < snapshot.cells.length && r < snapshot.rows; r++) {
    const row = snapshot.cells[r];
    if (!row) continue;
    let line = "";
    for (let c = 0; c < row.length && c < snapshot.cols; c++) {
      const cell = row[c];
      line += cell?.ch || " ";
    }
    term.write(line + "\r\n");
  }
  term.write(`\x1b[${snapshot.cursor.row + 1};${snapshot.cursor.col + 1}H`);
}

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
  onActivate: (id: string) => void;
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

const CONTAINER_STYLE = {
  position: "absolute" as const,
  inset: 0,
  background: "#0c0c0c",
};

export const TerminalPane = memo(function TerminalPane({
  terminalId, shell, cwd, title, agentId, isActive, onActivate,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const [snapshot, setSnapshot] = useState<FrameSnapshot | null>(null);

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
      invoke("terminal_write", {
        terminalId: tid,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(() => {});
    });

    return () => {
      unlistenRef.current?.();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 2. Gestione stato attivo: fit (dopo layout) + focus + spawn PTY + restore snapshot
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    if (isActive) {
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
      });

      // Notifica il backend che questo terminale è attivo
      invoke("terminal_set_active", { terminalId }).catch(() => {});

      // Spawn PTY solo al primo attivamento
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        invoke("terminal_spawn", {
          terminalId, shell, cwd, cols: term.cols, rows: term.rows,
        }).catch(() => {});
      }

      // Restore snapshot se disponibile
      if (snapshot) {
        renderSnapshotToTerm(term, snapshot);
        setSnapshot(null);
      }

      // Agent launch
      if (agentId) {
        agentLaunchQueue.enqueue(terminalId, agentId);
      }
    }
  }, [isActive, terminalId, shell, cwd, agentId, snapshot]);

  // 3. Listener output terminale — solo quando attivo
  useEffect(() => {
    if (!isActive) {
      // Cattura snapshot quando si disattiva
      invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId })
        .then((s) => { if (s && s.cells) setSnapshot(s); })
        .catch(() => {});
      return;
    }

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
  }, [isActive, terminalId]);

  // 4. Resize handler
  useEffect(() => {
    if (!isActive) return;

    const handleResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      fitAddon.fit();
      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows })
        .catch(() => {});
    };

    // Fit iniziale dopo che il DOM è stabilizzato
    const raf = requestAnimationFrame(() => handleResize());

    window.addEventListener("resize", handleResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
    };
  }, [isActive, terminalId]);

  useTerminalInput(terminalId, containerRef);

  const handleActivate = useCallback(() => {
    onActivate(terminalId);
  }, [terminalId, onActivate]);

  return (
    <div
      style={isActive ? ACTIVE_STYLE : INACTIVE_STYLE}
      onClick={isActive ? undefined : handleActivate}
      tabIndex={-1}
      role="button"
    >
      <div ref={containerRef} style={{ ...CONTAINER_STYLE, display: isActive ? '' : 'none' }} />
      {!isActive && <TerminalSnapshot snapshot={snapshot} title={title} />}
    </div>
  );
});
