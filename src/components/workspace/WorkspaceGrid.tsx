import { AnimatePresence } from "framer-motion";
import { TerminalPane } from "./TerminalPane";
import type { TerminalConfig } from "../../stores/terminalStore";

interface WorkspaceGridProps {
  rows: number;
  cols: number;
  terminals: TerminalConfig[];
}

export function WorkspaceGrid({ rows, cols, terminals }: WorkspaceGridProps) {
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
      className="grid flex-1 gap-2 p-4"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      <AnimatePresence mode="popLayout">
        {terminals.map((term) => (
          <TerminalPane
            key={term.id}
            terminalId={term.id}
            shell={term.shell}
            cwd={term.cwd}
            title={term.title}
            agentId={term.agentId}
            isActive={false}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
