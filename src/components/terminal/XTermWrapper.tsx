import { useEffect, useRef, memo } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { spawn, type IPty } from "tauri-pty";
import "xterm/css/xterm.css";

interface XTermWrapperProps {
  terminalId: string;
  shell: string;
  cwd: string;
  totalTerminals?: number;
  onTitleChange?: (title: string) => void;
  onTerminalReady?: (pty: IPty) => void;
  onFocus?: () => void;
}

const TIMING: Record<number, { batchSize: number; delay: number }> = {
  4: { batchSize: 4, delay: 0 },
  6: { batchSize: 3, delay: 100 },
  8: { batchSize: 2, delay: 150 },
};
const DEFAULT_TIMING = { batchSize: 2, delay: 150 };

let initQueue: Promise<void> = Promise.resolve();
let batchCount = 0;
let totalTerminals = 4;

export const XTermWrapper = memo(function XTermWrapper({
  terminalId,
  shell,
  cwd,
  totalTerminals: total,
  onTitleChange,
  onTerminalReady,
  onFocus,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      scrollback: 5000,
      allowProposedApi: true,
    });

    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && e.type === "keydown") {
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    let pty: IPty | null = null;
    let pid = 0;
    let opened = false;
    let disposed = false;

    const spawnShell = () => {
      if (disposed) return;
      try {
        pty = spawn("powershell.exe", [], {
          cols: term.cols,
          rows: term.rows,
          cwd,
        });
        pid = pty.pid;

        pty.onData((data) => {
          if (!disposed) term.write(data);
        });

        pty.onExit(() => {
          pty = null;
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

    const setupTerminal = () => {
      if (opened || disposed) return;
      opened = true;
      fitObserver.disconnect();

      term.open(container);
      term.focus();
      fitAddon.fit();

      if (total) totalTerminals = total;
      const timing = TIMING[totalTerminals] || DEFAULT_TIMING;
      const currentBatch = batchCount++;
      const delay = Math.floor(currentBatch / timing.batchSize) * timing.delay;

      initQueue = initQueue.then(
        () =>
          new Promise<void>((resolve) => {
            spawnShell();
            setTimeout(resolve, delay);
          }),
      );
    };

    const fitObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries[0];
      if (
        entry &&
        entry.contentRect.width > 0 &&
        entry.contentRect.height > 0
      ) {
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
    const handleFocusIn = () => onFocusRef.current?.();
    container.addEventListener("focusin", handleFocusIn);

    const handlePaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain");
      if (text && pty && !disposed) {
        pty.write(text);
      }
    };
    container.addEventListener("paste", handlePaste);

    return () => {
      disposed = true;
      fitObserver.disconnect();
      container.removeEventListener("click", handleClick);
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("paste", handlePaste);
      if (pid) {
        invoke("kill_process_tree", { pid }).catch(() => {});
      }
      pty?.kill();
      term.dispose();
    };
  }, [terminalId, shell, cwd, total, onTitleChange, onTerminalReady]);

  return (
    <div
      ref={containerRef}
      style={CONTAINER_STYLE}
    />
  );
});

const CONTAINER_STYLE = {
  position: "absolute" as const,
  inset: 0,
  background: "#0c0c0c",
};

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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    initQueue = Promise.resolve();
    batchCount = 0;
  });
}
