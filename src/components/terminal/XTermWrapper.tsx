import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, type IPty } from "tauri-pty";
import "xterm/css/xterm.css";

interface XTermWrapperProps {
  terminalId: string;
  shell: string;
  cwd: string;
  onTitleChange?: (title: string) => void;
  onTerminalReady?: (pty: IPty) => void;
  onFocus?: () => void;
}

let initQueue: Promise<void> = Promise.resolve();

export function XTermWrapper({
  terminalId,
  shell,
  cwd,
  onTitleChange,
  onTerminalReady,
  onFocus,
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

    let pty: IPty | null = null;
    let opened = false;
    let disposed = false;

    const setupTerminal = () => {
      if (opened || disposed) return;
      opened = true;
      fitObserver.disconnect();

      term.open(container);
      term.focus();
      fitAddon.fit();

      const shellCmd = shell.toLowerCase() === "bash" ? "bash.exe" : "powershell.exe";

      const doSpawn = () => {
        if (disposed) return;
        try {
          pty = spawn(shellCmd, [], {
            cols: term.cols,
            rows: term.rows,
            cwd,
          });

          pty.onData((data) => {
            if (!disposed) term.write(data);
          });

          pty.onExit(({ exitCode }) => {
            if (!disposed) term.write(`\r\n[Exit ${exitCode}]\r\n`);
          });

          term.onData((data) => {
            if (pty && !disposed) pty.write(data);
          });

          term.onResize((e) => {
            if (pty && !disposed) pty.resize(e.cols, e.rows);
          });

          term.onTitleChange((title) => onTitleChange?.(title));
          onTerminalReady?.(pty);
        } catch (err) {
          console.error(`[XTerm ${terminalId}] Spawn error:`, err);
          if (!disposed) {
            term.write(`\r\nError: ${err}\r\n`);
          }
        }
      };

      initQueue = initQueue.then(() => new Promise<void>((resolve) => {
        doSpawn();
        setTimeout(resolve, 200);
      }));
    };

    const fitObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        if (!opened) {
          setupTerminal();
        } else {
          fitAddon.fit();
          pty?.resize(term.cols, term.rows);
        }
      }
    });
    fitObserver.observe(container);

    const handleClick = () => term.focus();
    container.addEventListener("click", handleClick);
    const handleFocusIn = () => onFocus?.();
    container.addEventListener("focusin", handleFocusIn);

    return () => {
      disposed = true;
      fitObserver.disconnect();
      container.removeEventListener("click", handleClick);
      container.removeEventListener("focusin", handleFocusIn);
      pty?.kill();
      term.dispose();
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
