import { XTermWrapper } from "../terminal/XTermWrapper";
import { TerminalHeader } from "../terminal/TerminalHeader";

export function TerminalPane() {
  return (
    <div className="flex flex-col rounded-pane bg-neutral-surface border overflow-hidden"
      style={{ borderColor: "var(--color-neutral-border)" }}
    >
      <TerminalHeader />
      <div className="flex-1 min-h-0">
        <XTermWrapper />
      </div>
    </div>
  );
}
