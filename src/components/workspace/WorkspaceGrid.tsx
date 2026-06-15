import { TerminalPane } from "./TerminalPane";

interface WorkspaceGridProps {
  rows: number;
  cols: number;
  terminalIds: string[];
}

export function WorkspaceGrid({ rows, cols, terminalIds }: WorkspaceGridProps) {
  return (
    <div
      className="grid flex-1 gap-2 p-4"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {terminalIds.map((id) => (
        <TerminalPane key={id} />
      ))}
    </div>
  );
}
