import { useRef, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import type { FrameSnapshot } from "./types";
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

export function useTerminalPool() {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const snapshotsRef = useRef<Map<string, FrameSnapshot>>(new Map());
  const containerRef = useRef<HTMLElement | null>(null);

  const initXTerm = useCallback(() => {
    if (xtermRef.current) return;
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      scrollback: 0,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
  }, []);

  const attachTo = useCallback(async (container: HTMLElement, terminalId: string) => {
    const term = xtermRef.current;
    if (!term) return;

    if (activeTerminalIdRef.current) {
      await captureSnapshot(activeTerminalIdRef.current);
      detachCurrent();
    }

    containerRef.current = container;
    term.open(container);
    fitAddonRef.current?.fit();
    term.focus();

    try {
      const snapshot = await invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId });
      if (snapshot && snapshot.cells) {
        snapshotsRef.current.set(terminalId, snapshot);
        renderSnapshotToTerm(term, snapshot);
      }
    } catch {
      term.clear();
    }

    await invoke("terminal_set_active", { terminalId });
    activeTerminalIdRef.current = terminalId;
  }, []);

  const detachCurrent = useCallback(() => {
    const term = xtermRef.current;
    if (term) {
      term.clear();
    }
    containerRef.current = null;
    activeTerminalIdRef.current = null;
  }, []);

  const captureSnapshot = useCallback(async (terminalId: string) => {
    try {
      const snapshot = await invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId });
      if (snapshot) {
        snapshotsRef.current.set(terminalId, snapshot);
      }
    } catch {
      // Ignore snapshot errors
    }
  }, []);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  const dispose = useCallback(() => {
    xtermRef.current?.dispose();
    xtermRef.current = null;
    fitAddonRef.current = null;
    snapshotsRef.current.clear();
    containerRef.current = null;
    activeTerminalIdRef.current = null;
  }, []);

  return {
    initXTerm, attachTo, detachCurrent, captureSnapshot, fit, dispose,
    term: xtermRef,
    fitAddon: fitAddonRef,
    getSnapshot: (id: string) => snapshotsRef.current.get(id) ?? null,
    setSnapshot: (id: string, s: FrameSnapshot) => { snapshotsRef.current.set(id, s); },
    get activeTerminalId() { return activeTerminalIdRef.current; },
    get container() { return containerRef.current; },
  };
}
