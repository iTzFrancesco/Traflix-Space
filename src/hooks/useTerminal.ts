import { useCallback } from "react";
import { useTerminalStore } from "../stores/terminalStore";

export function useTerminal() {
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const killTerminal = useTerminalStore((s) => s.killTerminal);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const updateTerminalTitle = useTerminalStore((s) => s.updateTerminalTitle);
  const setTerminalPtyId = useTerminalStore((s) => s.setTerminalPtyId);
  const getTerminalsByWorkspace = useTerminalStore((s) => s.getTerminalsByWorkspace);

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
