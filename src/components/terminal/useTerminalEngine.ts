import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { frameReceiver } from "./FrameReceiver";
import type { FrameSnapshot } from "./types";

export function useTerminalEngine() {
  const spawn = useCallback(async (config: {
    terminalId: string; shell: string; cwd: string; cols: number; rows: number;
  }) => invoke("terminal_spawn", config), []);

  const write = useCallback(async (terminalId: string, data: string) => {
    const encoder = new TextEncoder();
    return invoke("terminal_write", { terminalId, data: Array.from(encoder.encode(data)) });
  }, []);

  const resize = useCallback(async (terminalId: string, cols: number, rows: number) =>
    invoke("terminal_resize", { terminalId, cols, rows }), []);

  const kill = useCallback(async (terminalId: string) =>
    invoke("terminal_kill", { terminalId }), []);

  const setActive = useCallback(async (terminalId: string | null) => {
    frameReceiver.setActive(terminalId);
    return invoke("terminal_set_active", { terminalId: terminalId || "" });
  }, []);

  const getSnapshot = useCallback(async (terminalId: string) =>
    invoke<FrameSnapshot>("terminal_get_snapshot", { terminalId }), []);

  const getScrollback = useCallback(async (terminalId: string, offset: number, limit: number) =>
    invoke("terminal_get_scrollback", { terminalId, offset, limit }), []);

  return { spawn, write, resize, kill, setActive, getSnapshot, getScrollback };
}
