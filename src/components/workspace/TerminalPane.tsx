import { useState, useCallback } from "react";
import { motion } from "framer-motion";
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
  const [, setPtyId] = useState<string | null>(null);
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
    async (newPtyId: string) => {
      setPtyId(newPtyId);
      useTerminalStore.getState().setTerminalPtyId(terminalId, newPtyId);

      if (agentId) {
        try {
          await invoke("launch_agent", {
            ptyId: newPtyId,
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
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={handleActivate}
      className="flex flex-col overflow-hidden"
      style={{
        borderRadius: "4px",
        border: `1px solid ${isActive ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}`,
      }}
    >
      <div className="flex-1 min-h-0">
        <XTermWrapper
          shell={shell}
          cwd={cwd}
          onTitleChange={handleTitleChange}
          onTerminalReady={handleTerminalReady}
        />
      </div>
    </motion.div>
  );
}
