import { memo, useCallback } from "react";
import { type IPty } from "tauri-pty";
import { XTermWrapper } from "../terminal/XTermWrapper";
import { useTerminalStore } from "../../stores/terminalStore";
import { AGENTS } from "../../lib/agents";

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
  totalTerminals?: number;
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
};

export const TerminalPane = memo(function TerminalPane({
  terminalId,
  shell,
  cwd,
  agentId,
  isActive,
  totalTerminals,
}: TerminalPaneProps) {
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);

  const handleActivate = useCallback(() => {
    setActiveTerminal(terminalId);
  }, [terminalId, setActiveTerminal]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (newTitle) {
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
    <div style={isActive ? ACTIVE_STYLE : INACTIVE_STYLE}>
      <XTermWrapper
        terminalId={terminalId}
        shell={shell}
        cwd={cwd}
        totalTerminals={totalTerminals}
        onTitleChange={handleTitleChange}
        onTerminalReady={handleTerminalReady}
        onFocus={handleActivate}
      />
    </div>
  );
});
