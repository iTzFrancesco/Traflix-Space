import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "../stores/terminalStore";

export function useTerminal() {
  const { createTerminal, killTerminal, setActiveTerminal, updateTerminalTitle, setTerminalPtyId, getTerminalsByWorkspace } =
    useTerminalStore();

  const create = useCallback(
    (config: {
      id?: string;
      workspaceId: string;
      shell?: string;
      cwd: string;
      title?: string;
      agent?: string | null;
    }) => {
      const id = createTerminal({
        id: config.id,
        workspaceId: config.workspaceId,
        shell: config.shell || "powershell",
        cwd: config.cwd,
        title: config.title || config.shell || "powershell",
        process: config.shell || "powershell",
        agent: config.agent || null,
      });
      return id;
    },
    [createTerminal],
  );

  const kill = useCallback(
    async (id: string) => {
      const terminals = useTerminalStore.getState().terminals;
      const term = terminals.get(id);
      if (term?.ptyId) {
        try {
          await invoke("kill_pty", { id: term.ptyId });
        } catch (err) {
          console.error("Error killing PTY:", err);
        }
      }
      killTerminal(id);
    },
    [killTerminal],
  );

  const resize = useCallback(
    async (id: string, cols: number, rows: number) => {
      const terminals = useTerminalStore.getState().terminals;
      const term = terminals.get(id);
      if (term?.ptyId) {
        try {
          await invoke("resize_pty", { id: term.ptyId, cols, rows });
        } catch (err) {
          console.error("Error resizing PTY:", err);
        }
      }
    },
    [],
  );

  const write = useCallback(
    async (id: string, data: string) => {
      const terminals = useTerminalStore.getState().terminals;
      const term = terminals.get(id);
      if (term?.ptyId) {
        try {
          await invoke("write_pty", { id: term.ptyId, data });
        } catch (err) {
          console.error("Error writing to PTY:", err);
        }
      }
    },
    [],
  );

  return {
    create,
    kill,
    resize,
    write,
    setActiveTerminal,
    updateTerminalTitle,
    setTerminalPtyId,
    getTerminalsByWorkspace,
  };
}
