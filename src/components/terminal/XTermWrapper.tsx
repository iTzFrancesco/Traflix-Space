import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "xterm/css/xterm.css";

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
    const unlistenPromises: Promise<() => void>[] = [];

    const setupTerminal = () => {
      if (disposed || opened) return;
      opened = true;
      fitObserver.disconnect();

      console.log("[XTerm] setupTerminal: container dimensions:", container.getBoundingClientRect());
      fitAddon.fit();
      console.log("[XTerm] after fit: cols=", term.cols, "rows=", term.rows);

      invoke<string>("create_pty", {
        shell,
        cols: term.cols,
        rows: term.rows,
        cwd,
      })
        .then((id) => {
          if (disposed) {
            invoke("kill_pty", { id }).catch(() => {});
            return;
          }
          ptyId = id;
          console.log("[XTerm] PTY created:", id);
          onTerminalReady?.(id);

          const unlisten = listen<PtyOutputPayload>("pty-output", (event) => {
            if (disposed || event.payload.id !== id) return;
            if (event.payload.eof) {
              console.log("[XTerm] PTY EOF:", id);
              term.write("\r\n[Process completed]\r\n");
              return;
            }
            if (event.payload.data) {
              console.log("[XTerm] PTY output:", id, "len:", event.payload.data.length);
              try {
                const binary = Uint8Array.from(atob(event.payload.data), (c) =>
                  c.charCodeAt(0),
                );
                term.write(binary);
              } catch (e) {
                console.log("[XTerm] base64 decode failed, writing raw:", e);
                term.write(event.payload.data);
              }
            }
          });

          term.onData((data) => {
            console.log("[XTerm] term.onData:", JSON.stringify(data));
            invoke("write_pty", { id, data }).catch((e) => console.error("[XTerm] write_pty error:", e));
          });

          term.onTitleChange((title) => onTitleChange?.(title));

          term.onBinary((data) => {
            invoke("write_pty", { id, data }).catch(console.error);
          });

          unlistenPromises.push(unlisten);
        })
        .catch((err) => {
          console.error("[XTerm] create_pty error:", err);
          if (!disposed) term.write(`\r\nError: ${err}\r\n`);
        });
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
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()));
      if (ptyId) invoke("kill_pty", { id: ptyId }).catch(() => {});
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
