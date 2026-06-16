import { useState, useCallback } from "react";
import { type IPty } from "tauri-pty";
import { XTermWrapper } from "../terminal/XTermWrapper";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
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
  const [, setCurrentTitle] = useState(title);
  const { setActiveTerminal } = useTerminal();

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
    (pty: IPty) => {
      if (!agentId) return;
      const agent = AGENTS.find((a) => a.id === agentId);
      if (!agent) return;
      pty.write(`${agent.command} ${agent.args.join(" ")}\r\n`);
    },
    [agentId],
  );

  return (
    <div
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
        onFocus={handleActivate}
      />
    </div>
  );
}
