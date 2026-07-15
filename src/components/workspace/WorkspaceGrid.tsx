import { useCallback } from "react";
import { TerminalPane } from "./TerminalPane";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalConfig } from "../../stores/terminalStore";

interface WorkspaceGridProps {
  rows: number;
  cols: number;
  terminals: TerminalConfig[];
  onActivate: (id: string) => void;
  onCloseTerminal?: (id: string) => void;
}

export function WorkspaceGrid({ rows, cols, terminals, onActivate, onCloseTerminal }: WorkspaceGridProps) {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  // Stabilizza la callback per non invalidare React.memo di TerminalPane ad ogni render
  const stableOnActivate = useCallback((id: string) => {
    onActivate(id);
  }, [onActivate]);

  if (terminals.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <p className="text-sm text-neutral-text-muted leading-relaxed text-center">
          Nessun terminale configurato.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        flex: 1,
        gap: "16px",
        padding: "8px 16px 16px",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {terminals.map((term) => (
        <TerminalPane
          key={term.id}
          terminalId={term.id}
          shell={term.shell}
          cwd={term.cwd}
          title={term.title}
          agentId={term.agentId}
          isActive={term.id === activeTerminalId}
          onActivate={stableOnActivate}
          onClose={onCloseTerminal}
        />
      ))}
    </div>
  );
}
