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
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 10000,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: true,
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
              term.write("\r\n[Process completed]\r\n");
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
        term.write(`\r\nError: ${err}\r\n`);
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
      style={{ background: "#0c0c0c" }}
    />
  );
}

interface PtyOutputPayload {
  id: string;
  data: string;
  eof: boolean;
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
