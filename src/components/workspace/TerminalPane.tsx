import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { XTermWrapper } from "../terminal/XTermWrapper";
import { TerminalHeader } from "../terminal/TerminalHeader";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
import { useToastStore } from "../../stores/toastStore";
import { AGENTS } from "../../lib/agents";

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
  const [currentTitle, setCurrentTitle] = useState(title);
  const [, setPtyId] = useState<string | null>(null);
  const { kill, setActiveTerminal } = useTerminal();
  const { addToast } = useToastStore();

  const handleClose = useCallback(() => {
    kill(terminalId);
  }, [terminalId, kill]);

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

  const agentColor = agentId
    ? AGENTS.find((a) => a.id === agentId)?.color
    : undefined;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      onClick={handleActivate}
      className="flex flex-col rounded-pane bg-neutral-surface border overflow-hidden"
      style={{
        borderColor: isActive
          ? "rgba(232,93,4,0.3)"
          : "var(--color-neutral-border)",
        boxShadow: isActive
          ? "0 0 20px rgba(232,93,4,0.05)"
          : undefined,
      }}
    >
      <TerminalHeader
        title={currentTitle}
        agentId={agentId}
        agentColor={agentColor}
        isActive={isActive}
        onClose={handleClose}
      />
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
