import { useEffect, useRef, memo } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { readText, readImage } from "@tauri-apps/plugin-clipboard-manager";
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



let spawnIdx = 0;

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
  const idxRef = useRef(spawnIdx++);
  const ptyRef = useRef<IPty | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

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

    term.attachCustomKeyEventHandler(() => true);

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
        ptyRef.current = pty;

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

      term.open(container);
      term.focus();
      fitAddon.fit();

      const t = Math.max(total || 4, 4);
      const timing = TIMING[t] || DEFAULT_TIMING;
      const delay = Math.floor(idxRef.current / timing.batchSize) * timing.delay;

      setTimeout(() => spawnShell(), delay);
    };

    const saveImageFromBlob = async (blob: Blob, mimeType: string): Promise<string> => {
      const ext = mimeType.split("/")[1] || "png";
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `pasted_${ts}.${ext}`;
      const dest = `${cwdRef.current || "."}/${filename}`;
      const buf = await blob.arrayBuffer();
      await writeFile(dest, new Uint8Array(buf));
      return filename;
    };

    const handlePasteFromClipboard = async () => {
      if (disposed) return;
      const currentPty = ptyRef.current;
      if (!currentPty || disposed) return;

      try {
        const text = await readText();
        if (text) {
          currentPty.write(text);
          return;
        }
      } catch {
      }

      try {
        const image = await readImage();
        if (image) {
          const rgbaData = await image.rgba();
          const blob = new Blob([new Uint8Array(rgbaData) as BlobPart], { type: "image/png" });
          saveImageFromBlob(blob, "image/png")
            .then((filename) => {
              if (!disposed) currentPty.write(`\r\n\x1b[32m[Image saved: ${filename}]\x1b[0m\r\n`);
            })
            .catch((err) => {
              if (!disposed) currentPty.write(`\r\n\x1b[31m[Error saving image: ${err}]\x1b[0m\r\n`);
            });
        }
      } catch {
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const currentPty = ptyRef.current;
      if (!currentPty || disposed) return;
      const isPaste =
        (e.ctrlKey && e.key.toLowerCase() === "v") ||
        (e.shiftKey && e.key === "Insert");
      if (!isPaste) return;
      e.preventDefault();
      e.stopPropagation();
      handlePasteFromClipboard();
    };

    container.addEventListener("keydown", handleKeyDown, true);

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const currentPty = ptyRef.current;
      if (!currentPty || disposed) return;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const paths: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const path = (file as File & { path?: string }).path;
          if (path) {
            paths.push(path);
          } else {
            paths.push(file.name);
          }
        }
        currentPty.write(paths.join(" "));
        return;
      }

      const text = e.dataTransfer?.getData("text/plain");
      if (text) {
        currentPty.write(text);
      }
    };

    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);

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

    return () => {
      disposed = true;
      fitObserver.disconnect();
      container.removeEventListener("click", handleClick);
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("keydown", handleKeyDown, true);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
      ptyRef.current = null;
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


