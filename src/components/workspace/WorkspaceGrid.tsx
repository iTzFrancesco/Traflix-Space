import { useCallback, useEffect } from "react";
import { TerminalPane } from "./TerminalPane";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalConfig } from "../../stores/terminalStore";

interface WorkspaceGridProps {
  rows: number;
  cols: number;
  terminals: TerminalConfig[];
  closeRequest?: { terminalId: string; token: number } | null;
  onActivate: (id: string) => void;
  onCloseTerminal?: (id: string) => void;
}

export function WorkspaceGrid({
  rows,
  cols,
  terminals,
  closeRequest,
  onActivate,
  onCloseTerminal,
}: WorkspaceGridProps) {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const focusedTerminalId = useTerminalStore((s) => s.focusedTerminalId);
  const toggleFocusTerminal = useTerminalStore((s) => s.toggleFocusTerminal);

  // Only apply focus mode if the focused terminal belongs to THIS workspace.
  // This allows focus to persist across workspace switches: when you leave
  // a workspace in focus mode and come back, the focus is restored because
  // WorkspaceGrid for the other workspace sees localFocusId = null.
  const localFocusId =
    focusedTerminalId !== null && terminals.some((t) => t.id === focusedTerminalId)
      ? focusedTerminalId
      : null;
  const isFocusMode = localFocusId !== null;
  const isDense = terminals.length > 4;

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
  // Skip when a close-confirm dialog is open (it handles Escape itself).
  useEffect(() => {
    if (!localFocusId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      useTerminalStore.getState().setFocusedTerminal(null);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [localFocusId]);

  // Clear focus if the focused terminal no longer exists in the store
  // (e.g., removed from workspace). Don't clear on workspace switch —
  // that's handled by localFocusId per-workspace filtering.
  const terminalIdsKey = terminals.map((t) => t.id).join(",");
  useEffect(() => {
    const focused = useTerminalStore.getState().focusedTerminalId;
    if (focused && !useTerminalStore.getState().terminals[focused]) {
      useTerminalStore.getState().setFocusedTerminal(null);
    }
  }, [terminalIdsKey, terminals]);

  if (terminals.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-8">
        <p className="surface-card px-6 py-4 text-center text-sm leading-relaxed text-neutral-text-muted">
          Nessun terminale configurato per questo workspace.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        flex: 1,
        gap: isFocusMode ? 0 : isDense ? "12px" : "16px",
        padding: isFocusMode
          ? "8px 12px 12px"
          : isDense
            ? "12px"
            : "12px 16px 16px",
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
        const isFocused = localFocusId === term.id;
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
              terminalCount={terminals.length}
              closeRequestToken={
                closeRequest?.terminalId === term.id
                  ? closeRequest.token
                  : undefined
              }
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
