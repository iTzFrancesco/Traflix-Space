import { memo, useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import type { TerminalOutput } from "../terminal/types";
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
  terminalId, shell, cwd, title: _title, agentId, isActive, onActivate,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const agentLaunchedRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

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

  // 2. Spawn PTY + launch agente al mount (senza click)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    invoke("terminal_spawn", {
      terminalId, shell, cwd, cols: Math.max(term.cols, 80), rows: Math.max(term.rows, 24),
    }).catch(() => {});

    if (agentId && !agentLaunchedRef.current) {
      agentLaunchedRef.current = true;
      agentLaunchQueue.enqueue(terminalId, agentId);
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

  // 4. Listener output terminale — sempre attivo
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

  // 4. Resize handler — sempre attivo
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

  return (
    <div
      style={isActive ? ACTIVE_STYLE : INACTIVE_STYLE}
      tabIndex={-1}
    >
      <div ref={containerRef} style={CONTAINER_STYLE} />
    </div>
  );
});
