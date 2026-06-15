import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "xterm/css/xterm.css";

interface XTermWrapperProps {
  terminalId: string;
  shell: string;
  cwd: string;
  onTitleChange?: (title: string) => void;
  onTerminalReady?: (ptyId: string) => void;
}

export function XTermWrapper({
  terminalId,
  shell,
  cwd,
  onTitleChange,
  onTerminalReady,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      /* WebGL not available */
    }

    let ptyId: string | null = null;
    let disposed = false;
    let opened = false;
    const cleanupFns: (() => void)[] = [];

    const setupTerminal = async () => {
      if (disposed || opened) return;
      opened = true;
      fitObserver.disconnect();

      fitAddon.fit();

      try {
        const unlisten = await listen<PtyOutputPayload>("pty-output", (event) => {
          if (disposed || event.payload.id !== terminalId) return;
          if (event.payload.eof) {
            term.write("\r\n[Process completed]\r\n");
            return;
          }
          if (event.payload.data) {
            try {
              const binary = Uint8Array.from(atob(event.payload.data), (c) =>
                c.charCodeAt(0),
              );
              term.write(binary);
            } catch {
              term.write(event.payload.data);
            }
          }
        });

        if (disposed) {
          unlisten();
          return;
        }
        cleanupFns.push(unlisten);

        const id = await invoke<string>("create_pty", {
          id: terminalId,
          shell,
          cols: term.cols,
          rows: term.rows,
          cwd,
        });

        if (disposed) {
          invoke("kill_pty", { id }).catch(() => {});
          return;
        }

        ptyId = id;
        onTerminalReady?.(id);

        term.onData((data) => {
          if (ptyId) invoke("write_pty", { id: ptyId, data }).catch(() => {});
        });

        term.onTitleChange((title) => onTitleChange?.(title));

        term.onBinary((data) => {
          if (ptyId) invoke("write_pty", { id: ptyId, data }).catch(() => {});
        });
      } catch (err) {
        if (!disposed) {
          console.error("[XTerm] Error during setup:", err);
          term.write(`\r\nError: ${err}\r\n`);
        }
      }
    };

    const fitObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        if (!opened) {
          term.open(container);
          setupTerminal();
        } else {
          fitAddon.fit();
        }
      }
    });
    fitObserver.observe(container);

    return () => {
      disposed = true;
      fitObserver.disconnect();
      cleanupFns.forEach((fn) => fn());
      if (ptyId) {
        invoke("kill_pty", { id: ptyId }).catch(() => {});
      }
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "#0c0c0c",
      }}
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
