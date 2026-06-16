import { memo, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalSnapshot } from "../terminal/TerminalSnapshot";
import { frameReceiver } from "../terminal/FrameReceiver";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import { useTerminalStore } from "../../stores/terminalStore";
import type { FrameDiff } from "../terminal/types";

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
  onActivate: (id: string) => void;
  pool: ReturnType<typeof import("../terminal/TerminalPool").useTerminalPool>;
}

const ACTIVE_STYLE = {
  position: "relative" as const,
  width: "100%",
  height: "100%",
  borderRadius: "4px",
  border: "1px solid rgba(255,255,255,0.12)",
  overflow: "hidden" as const,
};

const INACTIVE_STYLE = {
  position: "relative" as const,
  width: "100%",
  height: "100%",
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
  terminalId,
  shell,
  cwd,
  title,
  agentId,
  isActive,
  onActivate,
  pool,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spawnedRef = useRef(false);
  const handlerRegisteredRef = useRef(false);

  // Register frame receiver handler for this terminal
  useEffect(() => {
    if (!handlerRegisteredRef.current) {
      frameReceiver.register(terminalId, (diff: FrameDiff) => {
        if (isActive && pool.term.current) {
          const term = pool.term.current;
          if (diff.clearScreen) {
            term.clear();
            return;
          }
          for (const update of diff.dirtyCells || []) {
            const row = update.row;
            const col = update.col;
            const cell = update.cell;
            const ch = cell.ch;
            const fg = cell.fg;
            const bg = cell.bg;
            let styles = "";
            if (cell.bold) styles += "\x1b[1m";
            if (cell.italic) styles += "\x1b[3m";
            if (cell.underline) styles += "\x1b[4m";
            const fgCode = `\x1b[38;2;${fg.r};${fg.g};${fg.b}m`;
            const bgCode = `\x1b[48;2;${bg.r};${bg.g};${bg.b}m`;
            term.write(`\x1b[${row + 1};${col + 1}H${styles}${fgCode}${bgCode}${ch}\x1b[0m`);
          }
          if (diff.cursor) {
            term.write(`\x1b[${diff.cursor.row + 1};${diff.cursor.col + 1}H`);
          }
        }
      });
      handlerRegisteredRef.current = true;
    }
  }, [terminalId, isActive, pool.term]);

  // Spawn and attach when active
  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    (async () => {
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        try {
          await invoke("terminal_spawn", {
            terminalId, shell, cwd, cols: 80, rows: 24,
          });
          useTerminalStore.getState().markSpawned(terminalId);
          if (agentId) {
            agentLaunchQueue.enqueue(terminalId, agentId);
          }
        } catch {
          // Terminal may already be spawned
        }
      }

      pool.initXTerm();
      await pool.attachTo(containerRef.current!, terminalId);
    })();
  }, [isActive, terminalId, shell, cwd, pool]);

  // Fit terminal on resize
  useEffect(() => {
    if (!isActive) return;
    const handleResize = () => {
      setTimeout(() => pool.fit(), 50);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isActive, pool]);

  const handleActivate = useCallback(() => {
    onActivate(terminalId);
  }, [terminalId, onActivate]);

  if (!isActive) {
    const snapshot = pool.getSnapshot(terminalId);
    return (
      <div style={INACTIVE_STYLE} onClick={handleActivate} tabIndex={-1} role="button">
        <TerminalSnapshot snapshot={snapshot} title={title} />
      </div>
    );
  }

  return (
    <div style={ACTIVE_STYLE}>
      <div ref={containerRef} style={CONTAINER_STYLE} />
    </div>
  );
});
