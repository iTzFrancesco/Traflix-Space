import { useCallback } from "react";
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
    (id: string) => {
      killTerminal(id);
    },
    [killTerminal],
  );

  return {
    create,
    kill,
    setActiveTerminal,
    updateTerminalTitle,
    setTerminalPtyId,
    getTerminalsByWorkspace,
  };
}
