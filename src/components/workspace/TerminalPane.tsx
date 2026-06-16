import { memo, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TerminalSnapshot } from "../terminal/TerminalSnapshot";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { useTerminalStore } from "../../stores/terminalStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import type { TerminalOutput } from "../terminal/types";

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
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "4px",
  border: "1px solid #e85d04",
  overflow: "hidden" as const,
};

const INACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
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
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Listen for raw terminal output and write to xterm.js when active
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    (async () => {
      const unlisten = await listen<TerminalOutput>("terminal-output", (event) => {
        if (cancelled) return;
        const { terminalId: tid, data } = event.payload;
        if (tid !== terminalId) return;
        const term = pool.term.current;
        if (!term) return;
        term.write(new Uint8Array(data));
      });
      if (!cancelled) unlistenRef.current = unlisten;
    })();
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
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
        } catch {
          // Terminal may already be spawned
        }
      }

      pool.initXTerm();
      await pool.attachTo(containerRef.current!, terminalId);

      // Shell is now spawned (set_active triggers spawn_shell in backend).
      // Queue agent launch after shell is ready.
      if (agentId && spawnedRef.current) {
        agentLaunchQueue.enqueue(terminalId, agentId);
      }
    })();
  }, [isActive, terminalId, shell, cwd, pool, agentId]);

  // Fit terminal on resize and forward PTY resize to backend
  useEffect(() => {
    if (!isActive) return;
    const handleResize = () => {
      setTimeout(async () => {
        pool.fit();
        const term = pool.term.current;
        const fitAddon = pool.fitAddon.current;
        if (term && fitAddon) {
          const cols = term.cols;
          const rows = term.rows;
          try {
            await invoke("terminal_resize", { terminalId, cols, rows });
          } catch { }
        }
      }, 50);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isActive, pool, terminalId]);

  useTerminalInput(terminalId, containerRef);

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
