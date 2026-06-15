import { TerminalPane } from "./TerminalPane";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalConfig } from "../../stores/terminalStore";

interface WorkspaceGridProps {
  rows: number;
  cols: number;
  terminals: TerminalConfig[];
}

export function WorkspaceGrid({ rows, cols, terminals }: WorkspaceGridProps) {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  if (terminals.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-neutral-text-muted">
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
        gap: "1px",
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
        />
      ))}
    </div>
  );
}
