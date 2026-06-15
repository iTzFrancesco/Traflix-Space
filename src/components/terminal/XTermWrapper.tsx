import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
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

interface PtyOutputPayload {
  id: string;
  data: string;
  eof: boolean;
}

export function XTermWrapper({
  terminalId,
  shell,
  cwd,
  onTitleChange,
  onTerminalReady,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    console.log(`[XTerm ${terminalId}] Initializing...`);

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
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    let ptyId: string | null = null;
    let disposed = false;
    let opened = false;
    const cleanupFns: (() => void)[] = [];

    const setupTerminal = async () => {
      if (disposed || opened) return;
      opened = true;
      fitObserver.disconnect();

      console.log(`[XTerm ${terminalId}] Opening terminal container...`);
      term.open(container);
      term.write("\x1b[1;33mDEBUG: Terminal opened, waiting for PTY...\x1b[0m\r\n");
      term.write("Connecting to PTY...\r\n");

      // Temporaneamente disabilitiamo WebGL per debug
      /*
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch (e) {
        console.warn(`[XTerm ${terminalId}] WebGL addon failed:`, e);
      }
      */

      fitAddon.fit();

      const id = crypto.randomUUID();
      console.log(`[XTerm ${terminalId}] Generated ptyId: ${id}`);

      try {
        console.log(`[XTerm ${terminalId}] Subscribing to pty-output for ${id}`);
        const unlisten = await listen<PtyOutputPayload>("pty-output", (event) => {
          if (disposed || event.payload.id !== id) return;
          
          if (event.payload.eof) {
            console.log(`[XTerm ${terminalId}] Received EOF`);
            term.write("\r\n[Process completed]\r\n");
            return;
          }

          if (event.payload.data) {
            try {
              const binary = Uint8Array.from(atob(event.payload.data), c => c.charCodeAt(0));
              console.log(`[XTerm ${terminalId}] Received ${binary.length} bytes`);
              term.write(binary);
            } catch (err) {
              console.error(`[XTerm ${terminalId}] Error decoding output:`, err);
              term.write(event.payload.data);
            }
          }
        });

        if (disposed) {
          unlisten();
          return;
        }
        cleanupFns.push(unlisten);

        console.log(`[XTerm ${terminalId}] Invoking create_pty for ${id}`);
        const finalId = await invoke<string>("create_pty", {
          id,
          shell,
          cols: Math.max(term.cols, 1),
          rows: Math.max(term.rows, 1),
          cwd,
        });

        console.log(`[XTerm ${terminalId}] PTY created successfully: ${finalId}`);

        ptyId = finalId;
        onTerminalReady?.(finalId);

        term.onData((data) => {
          if (ptyId && !disposed) {
            invoke("write_pty", { id: ptyId, data }).catch(err => {
              console.error(`[XTerm ${terminalId}] Write error:`, err);
            });
          }
        });

        term.onTitleChange((title) => onTitleChange?.(title));
        
        term.onBinary((data) => {
          if (ptyId && !disposed) {
            invoke("write_pty", { id: ptyId, data }).catch(err => {
              console.error(`[XTerm ${terminalId}] Write binary error:`, err);
            });
          }
        });

      } catch (err) {
        console.error(`[XTerm ${terminalId}] Setup error:`, err);
        if (!disposed) term.write(`\r\nError: ${err}\r\n`);
      }
    };

    const fitObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        if (!opened) {
          setupTerminal();
        } else {
          fitAddon.fit();
          if (ptyId && !disposed) {
            invoke("resize_pty", { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => {});
          }
        }
      }
    });
    fitObserver.observe(container);

    return () => {
      console.log(`[XTerm ${terminalId}] Cleaning up...`);
      disposed = true;
      fitObserver.disconnect();
      cleanupFns.forEach(fn => fn());
      if (ptyId) {
        console.log(`[XTerm ${terminalId}] Killing PTY ${ptyId}`);
        invoke("kill_pty", { id: ptyId }).catch(() => {});
      }
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId, shell, cwd, onTitleChange, onTerminalReady]);

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
