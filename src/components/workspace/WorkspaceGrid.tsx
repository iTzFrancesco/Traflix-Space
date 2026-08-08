import { useCallback, useEffect } from "react";
import { X } from "lucide-react";
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
  onReorderTerminals?: (draggedId: string, targetId: string) => void;
}

export function WorkspaceGrid({
  rows,
  cols,
  terminals,
  closeRequest,
  onActivate,
  onCloseTerminal,
  onReorderTerminals,
}: WorkspaceGridProps) {
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const focusedTerminalId = useTerminalStore((state) => state.focusedTerminalId);
  const runtimeTerminals = useTerminalStore((state) => state.terminals);
  const toggleFocusTerminal = useTerminalStore((state) => state.toggleFocusTerminal);
  const localFocusId = focusedTerminalId !== null && terminals.some((terminal) => terminal.id === focusedTerminalId)
    ? focusedTerminalId
    : null;
  const isFocusMode = localFocusId !== null;
  const isDense = terminals.length > 4;

  const stableOnActivate = useCallback((id: string) => onActivate(id), [onActivate]);
  const stableOnToggleFocus = useCallback((id: string) => toggleFocusTerminal(id), [toggleFocusTerminal]);

  useEffect(() => {
    if (!localFocusId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      useTerminalStore.getState().setFocusedTerminal(null);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [localFocusId]);

  const terminalIdsKey = terminals.map((terminal) => terminal.id).join(",");
  useEffect(() => {
    const focused = useTerminalStore.getState().focusedTerminalId;
    if (focused && !useTerminalStore.getState().terminals[focused]) useTerminalStore.getState().setFocusedTerminal(null);
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
        gridTemplateColumns: isFocusMode ? "1fr" : `repeat(${cols}, 1fr)`,
        gridTemplateRows: isFocusMode ? "1fr" : `repeat(${rows}, 1fr)`,
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {terminals.map((terminal) => {
        const isFocused = localFocusId === terminal.id;
        const isHidden = isFocusMode && !isFocused;
        const hasExited = runtimeTerminals[terminal.id]?.exitCode !== null && runtimeTerminals[terminal.id]?.exitCode !== undefined;
        return (
          <div
            key={terminal.id}
            style={
              isFocusMode
                ? isFocused
                  ? { gridColumn: "1 / -1", gridRow: "1 / -1", minWidth: 0, minHeight: 0, display: "flex", zIndex: 2, position: "relative" }
                  : {
                      position: "absolute",
                      width: 1,
                      height: 1,
                      overflow: "hidden",
                      opacity: 0,
                      pointerEvents: "none",
                      zIndex: 0,
                      clipPath: "inset(50%)",
                    }
                : { minWidth: 0, minHeight: 0, display: "flex", position: "relative" }
            }
            aria-hidden={isHidden || undefined}
          >
            <TerminalPane
              terminalId={terminal.id}
              shell={terminal.shell}
              cwd={terminal.cwd}
              title={terminal.title}
              agentId={terminal.agentId}
              terminalCount={terminals.length}
              closeRequestToken={closeRequest?.terminalId === terminal.id ? closeRequest.token : undefined}
              isActive={terminal.id === activeTerminalId}
              isFocused={isFocused}
              focusModeActive={isFocusMode}
              onActivate={stableOnActivate}
              // TerminalPane historically schedules an automatic close after a
              // natural process exit. Once exited, keep that callback absent so
              // its recovery overlay remains usable instead of disappearing.
              onClose={hasExited ? undefined : onCloseTerminal}
              onToggleFocus={stableOnToggleFocus}
              onReorder={onReorderTerminals}
            />
            {hasExited && onCloseTerminal && !isHidden && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTerminal(terminal.id);
                }}
                className="absolute right-2 top-2 z-[35] inline-flex h-7 items-center gap-1.5 rounded-md border border-danger/30 bg-neutral-elevated/95 px-2 text-[10px] font-semibold text-danger transition-colors hover:bg-danger/[0.10]"
                title="Rimuovi il terminale chiuso"
                aria-label="Rimuovi il terminale chiuso"
              >
                <X size={12} />
                Rimuovi
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
