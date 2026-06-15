import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XTermWrapper } from "../terminal/XTermWrapper";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
import { useToastStore } from "../../stores/toastStore";

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
}

export function TerminalPane({
  terminalId,
  shell,
  cwd,
  title,
  agentId,
  isActive,
}: TerminalPaneProps) {
  const [, setCurrentTitle] = useState(title);
  const { setActiveTerminal } = useTerminal();
  const { addToast } = useToastStore();

  const handleActivate = useCallback(() => {
    setActiveTerminal(terminalId);
  }, [terminalId, setActiveTerminal]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (newTitle) {
        setCurrentTitle(newTitle);
        useTerminalStore.getState().updateTerminalTitle(terminalId, newTitle);
      }
    },
    [terminalId],
  );

  const handleTerminalReady = useCallback(
    async (ptyId: string) => {
      useTerminalStore.getState().setTerminalPtyId(terminalId, ptyId);

      if (agentId) {
        try {
          await invoke("launch_agent", {
            ptyId,
            terminalId,
            agentId,
            shell,
          });
        } catch (err) {
          console.error("Error launching agent:", err);
          addToast({ type: "error", message: `Errore lancio agente ${agentId}` });
        }
      }
    },
    [terminalId, agentId],
  );

  return (
    <div
      onClick={handleActivate}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: "4px",
        border: `1px solid ${isActive ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}`,
        overflow: "hidden",
      }}
    >
      <XTermWrapper
        terminalId={terminalId}
        shell={shell}
        cwd={cwd}
        onTitleChange={handleTitleChange}
        onTerminalReady={handleTerminalReady}
      />
    </div>
  );
}
