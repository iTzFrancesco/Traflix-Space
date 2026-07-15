import { useCallback, useEffect, useRef } from "react";
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

export function WorkspaceGrid({
  rows,
  cols,
  terminals,
  onActivate,
  onCloseTerminal,
}: WorkspaceGridProps) {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const focusedTerminalId = useTerminalStore((s) => s.focusedTerminalId);
  const toggleFocusTerminal = useTerminalStore((s) => s.toggleFocusTerminal);

  const stableOnActivate = useCallback(
    (id: string) => {
      onActivate(id);
    },
    [onActivate],
  );

  const stableOnToggleFocus = useCallback(
    (id: string) => {
      toggleFocusTerminal(id);
    },
    [toggleFocusTerminal],
  );

  // Escape exits focus mode without destroying panes.
  useEffect(() => {
    if (!focusedTerminalId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useTerminalStore.getState().setFocusedTerminal(null);
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [focusedTerminalId]);

  // Clear focus if the focused terminal is no longer in this workspace grid.
  const terminalIdsKey = terminals.map((t) => t.id).join(",");
  useEffect(() => {
    const focused = useTerminalStore.getState().focusedTerminalId;
    if (focused && !terminals.some((t) => t.id === focused)) {
      useTerminalStore.getState().setFocusedTerminal(null);
    }
  }, [terminalIdsKey, terminals]);

  // Track previous focus so we can force-fit on enter/exit (via pane props).
  const prevFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    prevFocusedRef.current = focusedTerminalId;
  }, [focusedTerminalId]);

  if (terminals.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <p className="text-sm text-neutral-text-muted leading-relaxed text-center">
          Nessun terminale configurato.
        </p>
      </div>
    );
  }

  const isFocusMode = focusedTerminalId !== null;

  return (
    <div
      style={{
        display: "grid",
        flex: 1,
        gap: isFocusMode ? 0 : "16px",
        padding: isFocusMode ? "8px 12px 12px" : "8px 16px 16px",
        // Keep the same grid tracks so hidden panes stay mounted; the focused
        // pane is stretched via gridColumn/gridRow spanning all cells.
        gridTemplateColumns: isFocusMode
          ? "1fr"
          : `repeat(${cols}, 1fr)`,
        gridTemplateRows: isFocusMode
          ? "1fr"
          : `repeat(${rows}, 1fr)`,
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {terminals.map((term) => {
        const isFocused = focusedTerminalId === term.id;
        const isHidden = isFocusMode && !isFocused;

        return (
          <div
            key={term.id}
            style={
              isFocusMode
                ? isFocused
                  ? {
                      // Fill the single-cell grid
                      gridColumn: "1 / -1",
                      gridRow: "1 / -1",
                      minWidth: 0,
                      minHeight: 0,
                      display: "flex",
                      zIndex: 2,
                    }
                  : {
                      // Keep mounted: zero footprint, no paint, no pointer events.
                      // visibility/position keep the xterm instance alive.
                      position: "absolute",
                      width: 1,
                      height: 1,
                      overflow: "hidden",
                      opacity: 0,
                      pointerEvents: "none",
                      zIndex: 0,
                      // Off-flow so it does not affect layout
                      clipPath: "inset(50%)",
                    }
                : {
                    minWidth: 0,
                    minHeight: 0,
                    display: "flex",
                  }
            }
            aria-hidden={isHidden || undefined}
          >
            <TerminalPane
              terminalId={term.id}
              shell={term.shell}
              cwd={term.cwd}
              title={term.title}
              agentId={term.agentId}
              isActive={term.id === activeTerminalId}
              isFocused={isFocused}
              focusModeActive={isFocusMode}
              onActivate={stableOnActivate}
              onClose={onCloseTerminal}
              onToggleFocus={stableOnToggleFocus}
            />
          </div>
        );
      })}
    </div>
  );
}
