import { CheckCircle2, GripHorizontal, Maximize2, Minimize2, X } from "lucide-react";
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, RefObject } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  ACTIVE_STYLE,
  CONTAINER_STYLE,
  EXITED_STYLE,
  FOCUSED_STYLE,
  INACTIVE_STYLE,
  TITLE_BAR_BRANCH,
  TITLE_BAR_DOT,
  TITLE_BAR_LEFT,
  TITLE_BAR_NAME,
  TITLE_BAR_RENAME_INPUT,
  TITLE_BAR_RIGHT,
  TOOL_BTN_BASE,
  type TerminalPaneProps,
} from "./TerminalPaneSupport";

export interface TerminalPaneViewProps {
  terminalId: string;
  terminalCount: number;
  isActive: boolean;
  isFocused: boolean;
  hasExited: boolean;
  exitCode: number | null;
  agentStatus: string;
  agentAttentionRequired: boolean;
  draggedTerminalId: string | null;
  isDragHovered: boolean;
  isDragOver: boolean;
  gitBranch: string | null;
  workspaceColor: string;
  editing: boolean;
  editValue: string;
  setEditValue: (value: string) => void;
  displayTitle: string;
  titleBarMetrics: {
    height: number;
    minHeight?: number;
    padding: string;
    dotSize: number;
    fontSize: number;
    iconSize: number;
    buttonSize: number;
  };
  titleBarStyle: CSSProperties;
  containerRef: RefObject<HTMLDivElement | null>;
  dragCleanupRef: MutableRefObject<(() => void) | null>;
  confirmClose: boolean;
  pendingNames: string[];
  streamSyncFailed: boolean;
  onClose?: TerminalPaneProps["onClose"];
  onToggleFocus?: TerminalPaneProps["onToggleFocus"];
  onReorder?: TerminalPaneProps["onReorder"];
  handleDragOver: (event: DragEvent) => void;
  handleDragEnter: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => void;
  handleCloseClick: (event: MouseEvent) => void;
  handleConfirmClose: (event: MouseEvent) => void;
  handleCancelClose: (event: MouseEvent) => void;
  handleToggleFocus: (event: MouseEvent) => void;
  handleStartRename: () => void;
  handleRenameSubmit: () => void;
  handleRenameKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  handleRetryStreamSync: () => void;
  handleRestart: () => Promise<void>;
}

export function TerminalPaneView({
  terminalId,
  terminalCount,
  isActive,
  isFocused,
  hasExited,
  exitCode,
  agentStatus,
  agentAttentionRequired,
  draggedTerminalId,
  isDragHovered,
  isDragOver,
  gitBranch,
  workspaceColor,
  editing,
  editValue,
  setEditValue,
  displayTitle,
  titleBarMetrics,
  titleBarStyle,
  containerRef,
  dragCleanupRef,
  confirmClose,
  pendingNames,
  streamSyncFailed,
  onClose,
  onToggleFocus,
  onReorder,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  handleCloseClick,
  handleConfirmClose,
  handleCancelClose,
  handleToggleFocus,
  handleStartRename,
  handleRenameSubmit,
  handleRenameKeyDown,
  handleRetryStreamSync,
  handleRestart,
}: TerminalPaneViewProps) {
  const outerStyle = hasExited
    ? EXITED_STYLE
    : isFocused
      ? FOCUSED_STYLE
      : isActive
        ? ACTIVE_STYLE
        : INACTIVE_STYLE;
  const dragOverlayStyle = {
    ...(isDragOver
      ? {
          borderColor: "var(--color-primary)",
          boxShadow:
            "inset 0 0 0 1px var(--color-primary), 0 0 16px rgba(232,93,4,0.15)",
        }
      : {}),
  };
  const attentionClass =
    agentAttentionRequired && !hasExited ? "agent-attention-pulse" : undefined;

  return (
    <div
      data-terminal-pane-id={terminalId}
      className={attentionClass}
      style={{
        ...outerStyle,
        ...(agentAttentionRequired && !hasExited
          ? { borderColor: "var(--color-primary)" }
          : {}),
        ...dragOverlayStyle,
      }}
      tabIndex={-1}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Full-pane drag overlay for reordering */}
      {draggedTerminalId !== null && draggedTerminalId !== terminalId && (
        <div
          onPointerEnter={() => {
            useTerminalStore.getState().setDragHoveredTerminalId(terminalId);
          }}
          onPointerLeave={() => {
            const state = useTerminalStore.getState();
            if (state.dragHoveredTerminalId === terminalId) {
              state.setDragHoveredTerminalId(null);
            }
          }}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: isDragHovered ? "rgba(18, 18, 18, 0.92)" : "rgba(18, 18, 18, 0.45)",
            border: isDragHovered ? "2px dashed var(--color-primary)" : "2px dashed rgba(255, 255, 255, 0.12)",
            borderRadius: "var(--radius-pane)",
            backdropFilter: isDragHovered ? "blur(4px)" : "none",
            transition: "all 0.2s ease-in-out",
          }}
        >
          {isDragHovered && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
                color: "var(--color-primary)",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "14px",
                textShadow: "0 0 10px rgba(232, 93, 4, 0.4)",
              }}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-bounce"
              >
                <path d="M12 5v14" />
                <path d="m19 12-7 7-7-7" />
              </svg>
              <span>Rilascia per spostare</span>
            </div>
          )}
        </div>
      )}
      {/* Title bar: workspace dot + name (left) | branch + buttons (right) */}
      <div style={titleBarStyle}>
        <div
          style={{
            ...TITLE_BAR_LEFT,
            gap: titleBarMetrics.dotSize,
            maxWidth: terminalCount > 1 ? "calc(50% - 32px)" : undefined,
          }}
        >
          <div
            style={{
              ...TITLE_BAR_DOT,
              width: titleBarMetrics.dotSize,
              height: titleBarMetrics.dotSize,
              background: workspaceColor,
            }}
          />
          {editing ? (
            <input
              style={{
                ...TITLE_BAR_RENAME_INPUT,
                fontSize: titleBarMetrics.fontSize,
              }}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              autoFocus
            />
          ) : (
            <span
              style={{ ...TITLE_BAR_NAME, fontSize: titleBarMetrics.fontSize }}
              onDoubleClick={handleStartRename}
            >
              {displayTitle}
            </span>
          )}
        </div>

        {/* Centered larger drag handle button */}
        {!hasExited && terminalCount > 1 && (
          <div
            onPointerDown={(e) => {
              if (dragCleanupRef.current) return;
              e.preventDefault();

              const pointerId = e.pointerId;
              const store = useTerminalStore.getState();
              store.setDraggedTerminalId(terminalId);

              const paneEl = e.currentTarget.parentElement?.parentElement;
              if (paneEl) {
                paneEl.style.setProperty("opacity", "0.35");
              }

              const resolveDragTarget = (clientX: number, clientY: number) => {
                const element = document.elementFromPoint(clientX, clientY);
                const pane = element?.closest<HTMLElement>("[data-terminal-pane-id]");
                const targetId = pane?.dataset.terminalPaneId ?? null;
                const latestStore = useTerminalStore.getState();
                latestStore.setDragHoveredTerminalId(
                  targetId && targetId !== terminalId ? targetId : null,
                );
              };

              const cleanup = () => {
                if (dragCleanupRef.current !== cleanup) return;
                dragCleanupRef.current = null;
                const latestStore = useTerminalStore.getState();
                latestStore.setDraggedTerminalId(null);
                latestStore.setDragHoveredTerminalId(null);
                if (paneEl) {
                  paneEl.style.removeProperty("opacity");
                }
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerCancel);
                window.removeEventListener("blur", handleWindowBlur);
              };

              const handlePointerMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== pointerId) return;
                moveEvent.preventDefault();
                resolveDragTarget(moveEvent.clientX, moveEvent.clientY);
              };

              const handlePointerUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== pointerId) return;
                upEvent.preventDefault();
                resolveDragTarget(upEvent.clientX, upEvent.clientY);
                const latestStore = useTerminalStore.getState();
                const targetId = latestStore.dragHoveredTerminalId;

                if (targetId && targetId !== terminalId && onReorder) {
                  onReorder(terminalId, targetId);
                }
                cleanup();
              };

              const handlePointerCancel = (cancelEvent: PointerEvent) => {
                if (cancelEvent.pointerId === pointerId) cleanup();
              };

              const handleWindowBlur = () => cleanup();

              dragCleanupRef.current = cleanup;
              window.addEventListener("pointermove", handlePointerMove);
              window.addEventListener("pointerup", handlePointerUp);
              window.addEventListener("pointercancel", handlePointerCancel);
              window.addEventListener("blur", handleWindowBlur);
            }}
            title="Trascina la barra al centro per spostare il terminale"
            aria-label="Trascina la barra al centro per spostare il terminale"
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "48px",
              height: "24px",
              borderRadius: "6px",
              cursor: "grab",
              color: "rgba(255,255,255,0.35)",
              backgroundColor: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              transition: "all 0.15s ease",
              zIndex: 10,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
              e.currentTarget.style.borderColor = "var(--color-primary)";
              e.currentTarget.style.color = "var(--color-primary)";
              e.currentTarget.style.boxShadow = "0 0 10px rgba(232,93,4,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.02)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = "rgba(255,255,255,0.35)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <GripHorizontal size={18} />
          </div>
        )}

        <div style={TITLE_BAR_RIGHT}>
          {agentStatus === "completed" && agentAttentionRequired && (
            <span
              title="L'agente ha completato l'ultimo turno"
              aria-label="Turno agente completato"
              style={{
                display: "inline-flex",
                alignItems: "center",
                color: "var(--color-signal)",
                marginRight: "4px",
              }}
            >
              <CheckCircle2 size={titleBarMetrics.iconSize} />
            </span>
          )}
          {gitBranch && terminalCount <= 4 && (
            <span
              style={{ ...TITLE_BAR_BRANCH, fontSize: titleBarMetrics.fontSize }}
              title={gitBranch}
            >
              <svg
                width={titleBarMetrics.iconSize}
                height={titleBarMetrics.iconSize}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {gitBranch}
            </span>
          )}

          {!hasExited && onToggleFocus && (
            <button
              type="button"
              onClick={handleToggleFocus}
              title={isFocused ? "Esci da Focus (Esc)" : "Focus mode"}
              aria-label={isFocused ? "Esci dalla modalità focus" : "Attiva modalità focus"}
              style={{
                ...TOOL_BTN_BASE,
                width: titleBarMetrics.buttonSize,
                height: titleBarMetrics.buttonSize,
                background: isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)",
                color: isFocused ? "#60a5fa" : "#a1a1aa",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.4)"
                  : "rgba(255,255,255,0.14)";
                e.currentTarget.style.color = isFocused ? "#93c5fd" : "#f4f4f5";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = isFocused ? "#60a5fa" : "#a1a1aa";
              }}
            >
              {isFocused ? (
                <Minimize2 size={titleBarMetrics.iconSize} />
              ) : (
                <Maximize2 size={titleBarMetrics.iconSize} />
              )}
            </button>
          )}

          {!hasExited && onClose &&
            (confirmClose ? (
              <div
                style={{
                  display: "flex",
                  gap: "4px",
                  alignItems: "center",
                  background: "rgba(12,12,12,0.96)",
                  borderRadius: "8px",
                  padding: "2px 4px",
                  border: "1px solid rgba(239,68,68,0.35)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "#ef4444",
                    padding: "0 4px",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  Chiudere?
                </span>
                <button
                  type="button"
                  onClick={handleConfirmClose}
                  title="Conferma chiusura"
                  aria-label="Conferma chiusura terminale"
                  style={{
                    ...TOOL_BTN_BASE,
                    width: titleBarMetrics.buttonSize,
                    height: titleBarMetrics.buttonSize,
                    background: "rgba(239,68,68,0.25)",
                    color: "#ef4444",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.45)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.25)";
                  }}
                >
                  ✓
                </button>
                <button
                  type="button"
                  onClick={handleCancelClose}
                  title="Annulla"
                  aria-label="Annulla chiusura terminale"
                  style={{
                    ...TOOL_BTN_BASE,
                    width: titleBarMetrics.buttonSize,
                    height: titleBarMetrics.buttonSize,
                    background: "rgba(255,255,255,0.08)",
                    color: "#a1a1aa",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.15)";
                    e.currentTarget.style.color = "#f4f4f5";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                    e.currentTarget.style.color = "#a1a1aa";
                  }}
                >
                  <X size={titleBarMetrics.iconSize} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCloseClick}
                title="Chiudi terminale"
                aria-label="Chiudi terminale"
                style={{
                  ...TOOL_BTN_BASE,
                  width: titleBarMetrics.buttonSize,
                  height: titleBarMetrics.buttonSize,
                  background: "rgba(239,68,68,0.2)",
                  color: "#ef4444",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.2)";
                }}
              >
                <X size={titleBarMetrics.iconSize} />
              </button>
            ))}
        </div>
      </div>

      <div ref={containerRef} style={CONTAINER_STYLE} />

      {pendingNames.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: "8px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 15,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 14px",
            borderRadius: "10px",
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            color: "var(--color-primary)",
            backgroundColor: "rgba(232,93,4,0.12)",
            border: "1px solid rgba(232,93,4,0.25)",
            backdropFilter: "blur(8px)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "currentColor",
            boxShadow: "0 0 8px currentColor",
            }}
          />
          <span>
            usa la skill: {pendingNames.join(" e ")}
          </span>
        </div>
      )}

      {streamSyncFailed && !hasExited && (
        <div
          role="alert"
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-danger/35 bg-neutral-elevated/95 px-3 py-2 text-[11px] text-neutral-text shadow-xl"
        >
          <span>Sincronizzazione terminale interrotta.</span>
          <button
            type="button"
            onClick={handleRetryStreamSync}
            className="rounded-md border border-primary/40 px-2 py-1 font-semibold text-primary hover:bg-primary/10"
          >
            Riprova
          </button>
        </div>
      )}

      {hasExited && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(12,12,12,0.84)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            zIndex: 20,
            backdropFilter: "blur(8px)",
            padding: "24px",
          }}
        >
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.6 }}
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "13px",
              color: "#ef4444",
              fontWeight: 500,
              opacity: 0.9,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Terminale chiuso (exit code: {exitCode})
          </span>
          <button
            type="button"
            onClick={handleRestart}
            style={{
              minHeight: "40px",
              padding: "10px 20px",
              borderRadius: "10px",
              border: "1px solid rgba(232,93,4,0.4)",
              background: "rgba(232,93,4,0.12)",
              color: "#e85d04",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontSize: "14px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "10px",
              letterSpacing: "0.02em",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.25)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.7)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.12)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.4)";
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Riapri terminale
          </button>
        </div>
      )}
    </div>
  );
}
