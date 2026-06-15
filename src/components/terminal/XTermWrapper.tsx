import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface XTermWrapperProps {
  shell: string;
  cwd: string;
  onTitleChange?: (title: string) => void;
  onTerminalReady?: (ptyId: string) => void;
}

export function XTermWrapper({
  shell,
  cwd,
  onTitleChange,
  onTerminalReady,
}: XTermWrapperProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    fitAddonRef.current.fit();
    const term = xtermRef.current;
    const ptyId = ptyIdRef.current;
    if (ptyId) {
      invoke("resize_pty", {
        id: ptyId,
        cols: term.cols,
        rows: term.rows,
      }).catch(console.error);
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      theme: TRAFLIX_THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "block",
      cursorWidth: 2,
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 10000,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
    });

    const webglAddon = new WebglAddon();
    const fitAddon = new FitAddon();

    term.loadAddon(webglAddon);
    term.loadAddon(fitAddon);

    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const cols = term.cols;
    const rows = term.rows;

    invoke<string>("create_pty", { shell, cols, rows, cwd })
      .then((ptyId) => {
        ptyIdRef.current = ptyId;
        onTerminalReady?.(ptyId);

        const unlistenPromise = listen<PtyOutputPayload>("pty-output", (event) => {
          if (event.payload.id === ptyId) {
            if (event.payload.eof) {
              term.write("\r\n\x1b[31m[Process completed]\x1b[0m\r\n");
              return;
            }
            if (event.payload.data) {
              try {
                const binary = Uint8Array.from(atob(event.payload.data), (c) =>
                  c.charCodeAt(0)
                );
                term.write(binary);
              } catch {
                term.write(event.payload.data);
              }
            }
          }
        });

        const disposeData = term.onData((data) => {
          invoke("write_pty", { id: ptyId, data }).catch(console.error);
        });

        const disposeTitle = term.onTitleChange((title) => {
          onTitleChange?.(title);
        });

        const disposeBinary = term.onBinary((data) => {
          invoke("write_pty", { id: ptyId, data }).catch(console.error);
        });

        const resizeObserver = new ResizeObserver(() => {
          handleResize();
        });

        if (terminalRef.current) {
          resizeObserver.observe(terminalRef.current);
        }
        resizeObserverRef.current = resizeObserver;

        return () => {
          unlistenPromise.then((unlisten) => unlisten());
          disposeData.dispose();
          disposeTitle.dispose();
          disposeBinary.dispose();
          resizeObserver.disconnect();
        };
      })
      .catch((err) => {
        term.write(`\r\n\x1b[31mError: ${err}\x1b[0m\r\n`);
      });

    return () => {
      invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      fitAddon.dispose();
      webglAddon.dispose();
      term.dispose();
      ptyIdRef.current = null;
    };
  }, []);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full min-h-0"
      style={{ background: "#111113" }}
    />
  );
}

interface PtyOutputPayload {
  id: string;
  data: string;
  eof: boolean;
}

const TRAFLIX_THEME = {
  foreground: "#f4f4f5",
  background: "#111113",
  cursor: "#e85d04",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(232,93,4,0.3)",
  selectionInactiveBackground: "rgba(232,93,4,0.15)",
  black: "#18181b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#f4f4f5",
  brightBlack: "#27272a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
};
