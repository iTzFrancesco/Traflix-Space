import { useState, useRef, useEffect, useMemo } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Bell,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";
import { getWorkspaceColor } from "../../lib/workspaceColors";

const IS_DEV = import.meta.env.DEV;

export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const terminals = useTerminalStore((s) => s.terminals);
  const isCollapsed = useUIStore((s) => s.isCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const wizardOpen = useUIStore((s) => s.wizardOpen);
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    workspaceId: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const pendingByWorkspace = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const terminal of Object.values(terminals)) {
      if (terminal.agentAttentionRequired) {
        counts[terminal.workspaceId] = (counts[terminal.workspaceId] ?? 0) + 1;
      }
    }
    return counts;
  }, [terminals]);

  // Apri il wizard quando il keyboard shortcut (Ctrl+N) imposta activeModal
  useEffect(() => {
    if (activeModal === "new-workspace") {
      setWizardOpen(true);
      closeModal();
    }
  }, [activeModal, closeModal]);

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const confirmRename = (id: string) => {
    if (renameValue.trim()) {
      updateWorkspace(id, { name: renameValue.trim() });
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const handleDelete = async (id: string) => {
    // Notifica il backend per primo
    try {
      await invokeWithTimeout(() => invoke("delete_workspace", { id }), 10000);
    } catch (err) {
      console.error("Errore eliminazione workspace backend:", err);
    }
    // Kill terminali della workspace eliminata
    useTerminalStore.getState().killWorkspaceTerminals(id);
    removeWorkspace(id);
    setConfirmDeleteId(null);
  };

  // Chiudi menu contestuale al click fuori
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    // Piccolo delay per evitare che lo stesso click che apre lo chiuda
    const timer = setTimeout(() => {
      document.addEventListener("click", close);
      document.addEventListener("contextmenu", close);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  /* ─── Resize handler: zero re-render durante il drag ─── */
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!sidebarRef.current) return;
    const handleEl = e.currentTarget as HTMLElement;

    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarRef.current.getBoundingClientRect().width;
    isDraggingRef.current = true;
    const defaultSnap = sidebarWidth;

    // Feedback visivo immediato via DOM diretto (nessun re-render)
    const lineEl = handleEl.querySelector<HTMLElement>("[data-resize-line]");
    const bgEl = handleEl.querySelector<HTMLElement>("[data-resize-bg]");
    if (lineEl) {
      lineEl.style.backgroundColor = "var(--color-primary)";
      lineEl.style.boxShadow = "0 0 6px rgba(232,93,4,0.4)";
      lineEl.style.width = "2px";
    }
    if (bgEl) {
      bgEl.style.background =
        "linear-gradient(90deg, transparent, rgba(232,93,4,0.12))";
      bgEl.style.opacity = "1";
    }

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.max(
        240,
        Math.min(500, dragStartWidth.current + delta),
      );
      // Liscio — nessun grid snap
      // Solo snap al default quando ci passi vicino (entro 10px)
      const finalWidth =
        Math.abs(newWidth - defaultSnap) <= 10 ? defaultSnap : newWidth;
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${finalWidth}px`;
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      // Reset feedback visivo
      if (lineEl) {
        lineEl.style.backgroundColor = "";
        lineEl.style.boxShadow = "";
        lineEl.style.width = "";
      }
      if (bgEl) {
        bgEl.style.background = "";
        bgEl.style.opacity = "";
      }

      // Salva la larghezza finale solo al rilascio
      if (sidebarRef.current) {
        const finalWidth = parseFloat(sidebarRef.current.style.width);
        if (!isNaN(finalWidth)) {
          setSidebarWidth(Math.round(finalWidth));
        }
      }

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  /* ─── Collapsed mode: compact dots ─── */
  if (isCollapsed) {
    return (
      <>
        <motion.aside
          layout
          className="flex flex-col items-center h-full select-none py-10 gap-8"
          style={{
            width: "80px",
            backgroundColor: "var(--color-neutral-surface)",
            borderRight: "1px solid var(--color-neutral-border)",
          }}
        >
          {/* Expand button */}
          <motion.div
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-colors duration-200 cursor-pointer"
            style={{ color: "var(--color-neutral-text-muted)" }}
            onClick={toggleSidebar}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
            title="Espandi sidebar"
          >
            <PanelLeftOpen size={22} />
          </motion.div>

          {/* New workspace dot */}
          <motion.div
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.9 }}
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-colors duration-200 cursor-pointer"
            style={{
              color: "var(--color-primary)",
              backgroundColor: "rgba(232,93,4,0.1)",
            }}
            onClick={() => setWizardOpen(true)}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(232,93,4,0.2)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(232,93,4,0.1)")
            }
            title="Nuovo Spazio"
          >
            <Plus size={19} />
          </motion.div>

          {/* Divider */}
          <div
            className="w-8 h-px"
            style={{ backgroundColor: "var(--color-neutral-border)" }}
          />

          {/* Workspace dots */}
          <div className="flex flex-col items-center gap-6 flex-1 overflow-y-auto">
            {workspaces.map((ws, index) => {
              const color = getWorkspaceColor(index);
              const isActive = activeWorkspaceId === ws.id;
              const pendingCount = pendingByWorkspace[ws.id] ?? 0;

              return (
                <motion.button
                  key={ws.id}
                  whileHover={{ scale: 1.15 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setActiveWorkspace(ws.id)}
                  className="relative w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200"
                  style={{
                    backgroundColor: isActive
                      ? `${color}18`
                      : "transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive)
                      e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive)
                      e.currentTarget.style.backgroundColor = "transparent";
                  }}
                  title={ws.name}
                >
                  <div
                    className="w-6 h-6 rounded-full transition-all duration-200"
                    style={{
                      backgroundColor: color,
                      boxShadow: isActive
                        ? `0 0 0 2.5px var(--color-neutral-surface), 0 0 0 4.5px ${color}`
                        : `0 0 0 0px var(--color-neutral-surface), 0 0 0 0px ${color}`,
                    }}
                  />
                  {pendingCount > 0 && (
                    <span
                      className="agent-attention-badge absolute -right-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full border text-xs font-bold"
                      aria-label={`${pendingCount} terminal${pendingCount === 1 ? "e" : "i"} in attesa`}
                      style={{
                        backgroundColor: "var(--color-primary)",
                        borderColor: "var(--color-neutral-surface)",
                        color: "var(--color-neutral-bg)",
                      }}
                    >
                      {pendingCount}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>

          {/* DEV badge */}
          {IS_DEV && (
            <div className="pb-4 flex justify-center">
              <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]" />
            </div>
          )}
        </motion.aside>

        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

  /* ─── Expanded mode: full sidebar ─── */
  return (
    <>
      <motion.aside
        ref={sidebarRef}
        layout={false}
        className="flex flex-col h-full select-none relative"
        style={{
          width: `${sidebarWidth}px`,
          minWidth: "240px",
          backgroundColor: "var(--color-neutral-surface)",
          borderRight: "1px solid var(--color-neutral-border)",
        }}
      >
        {/* Resize handle */}
        <div
          onMouseDown={handleResizeMouseDown}
          className="absolute right-0 top-0 bottom-0 w-2 z-20 cursor-col-resize group"
        >
          <div
            data-resize-line
            className="absolute inset-y-2 right-0 w-px transition-all duration-150 group-hover:w-0.5"
            style={{
              backgroundColor: "var(--color-neutral-border)",
            }}
          />
          <div
            data-resize-bg
            className="absolute inset-y-0 right-0 w-full opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.04))",
            }}
          />
        </div>
        {/* Top section - Collapse button + New workspace */}
        <div className="flex items-center gap-3 px-4 pt-5 pb-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={toggleSidebar}
            className="ui-icon-button shrink-0"
            style={{ color: "var(--color-neutral-text-muted)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
            title="Comprimi sidebar"
          >
            <PanelLeftClose size={22} />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02, y: -0.5 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setWizardOpen(true)}
            className="flex-1 flex items-center justify-center gap-3 px-5 py-4 text-base font-extrabold rounded-xl transition-all duration-300 shadow-sm hover:shadow-[0_0_16px_rgba(255,157,36,0.15)]"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              color: "var(--color-neutral-text)",
              border: "1px solid rgba(255,157,36,0.2)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)";
              e.currentTarget.style.borderColor = "var(--color-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(255,157,36,0.2)";
            }}
          >
            <Plus size={22} style={{ color: "var(--color-primary)" }} />
            Nuovo Spazio
          </motion.button>
        </div>

        {/* Workspaces section */}
        <div className="flex-1 overflow-y-auto px-4 pt-5 pb-5">
          {/* Section header */}
          <div className="flex items-center px-2 pb-3 mb-3 border-b border-white/[0.06]">
            <span
              className="text-[0.8125rem] font-semibold uppercase tracking-[0.12em]"
              style={{
                fontFamily: "var(--font-display)",
                color: "var(--color-neutral-text-muted)",
              }}
            >
              Workspaces
            </span>
          </div>

          {/* Workspace list */}
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {workspaces.map((ws, index) => {
                const color = getWorkspaceColor(index);
                const isActive = activeWorkspaceId === ws.id;
                const terminalCount = ws.terminalCount;
                const pendingCount = pendingByWorkspace[ws.id] ?? 0;
                const isRenaming = renamingId === ws.id;
                const isDeleting = confirmDeleteId === ws.id;

                return (
                  <motion.div
                    key={ws.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={{
                      type: "spring",
                      stiffness: 500,
                      damping: 35,
                    }}
                  >
                    {isRenaming ? (
                      /* Inline rename mode */
                      <div
                        className="relative flex items-center gap-3.5 px-5 py-5 rounded-xl border"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.025)",
                          borderColor: `${color}20`,
                        }}
                      >
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[2px] rounded-r"
                          style={{ backgroundColor: color }}
                        />
                        <div
                          className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${color}18` }}
                        >
                          <div
                            className="w-5 h-5 rounded"
                            style={{ backgroundColor: color }}
                          />
                        </div>
                        <input
                          ref={inputRef}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmRename(ws.id);
                            if (e.key === "Escape") cancelRename();
                          }}
                          onBlur={() => confirmRename(ws.id)}
                          className="flex-1 bg-transparent text-[1rem] font-medium outline-none border-b border-white/20 pb-0.5"
                          style={{ color: "var(--color-neutral-text)" }}
                        />
                        <button
                          onClick={() => confirmRename(ws.id)}
                          className="p-2 rounded-lg transition-colors"
                          style={{ color: "#10b981" }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(16,185,129,0.15)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                        >
                          <Check size={18} />
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-2 rounded-lg transition-colors"
                          style={{ color: "var(--color-neutral-text-muted)" }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.06)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                        >
                          <X size={18} />
                        </button>
                      </div>
                    ) : isDeleting ? (
                      /* Delete confirmation mode */
                      <div
                        className="relative flex items-center gap-3.5 px-5 py-5 rounded-xl border"
                        style={{
                          backgroundColor: "rgba(239,68,68,0.035)",
                          borderColor: "rgba(239, 68, 68, 0.2)",
                        }}
                      >
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[2px] rounded-r bg-red-500"
                        />
                        {/* Spacer invisibile per matchare l'altezza dell'icona workspace (48px) */}
                        <div className="w-0 h-12 shrink-0" aria-hidden="true" />
                        <span
                          className="flex-1 text-[0.9375rem] truncate"
                          style={{ color: "var(--color-neutral-text-dim)" }}
                        >
                          Eliminare "{ws.name}"?
                        </span>
                        <button
                          onClick={() => handleDelete(ws.id)}
                          className="px-5 py-2 rounded-lg text-[0.875rem] font-medium transition-colors"
                          style={{
                            backgroundColor: "rgba(239,68,68,0.2)",
                            color: "#ef4444",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(239,68,68,0.35)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(239,68,68,0.2)")
                          }
                        >
                          Sì
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-5 py-2 rounded-lg text-[0.875rem] font-medium transition-colors"
                          style={{
                            backgroundColor: "rgba(255,255,255,0.06)",
                            color: "var(--color-neutral-text-muted)",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.1)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.06)")
                          }
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      /* Normal workspace item */
                      <motion.div
                        role="button"
                        tabIndex={0}
                        onClick={() => setActiveWorkspace(ws.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            workspaceId: ws.id,
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            setActiveWorkspace(ws.id);
                          }
                        }}
                        className="surface-card relative flex items-center gap-3 w-full px-3 py-3 rounded-xl transition-all duration-200 group cursor-pointer border"
                        style={{
                          backgroundColor: isActive
                            ? "rgba(255,255,255,0.035)"
                            : "transparent",
                          borderColor: isActive
                            ? `${color}25`
                            : "var(--color-neutral-border)",
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.025)";
                            e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = "transparent";
                            e.currentTarget.style.borderColor = "var(--color-neutral-border)";
                          }
                        }}
                      >
                        {isActive && (
                          <span
                            className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[2px] rounded-r transition-all duration-200"
                            style={{ backgroundColor: color }}
                          />
                        )}
                        {/* Colored square icon */}
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-105"
                          style={{ backgroundColor: `${color}18` }}
                        >
                          <div
                            className="w-4 h-4 rounded"
                            style={{ backgroundColor: color }}
                          />
                        </div>

                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          {/* Workspace name */}
                          <span
                            className={`truncate text-[0.9375rem] text-left ${
                              isActive ? "font-semibold" : ""
                            }`}
                            style={{
                              color: isActive
                                ? "var(--color-neutral-text)"
                                : "var(--color-neutral-text-dim)",
                            }}
                          >
                            {ws.name}
                          </span>

                          {/* Terminal count badge */}
                          {terminalCount > 0 && (
                            <span
                              className="text-xs font-mono font-medium px-2.5 py-1 rounded-md shrink-0 transition-opacity duration-200"
                              style={{
                                backgroundColor: `${color}15`,
                                color: color,
                              }}
                            >
                              {terminalCount}
                            </span>
                          )}
                          {pendingCount > 0 && (
                            <span
                              className="agent-attention-badge inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px] font-mono font-bold shrink-0"
                              title={`${pendingCount} terminal${pendingCount === 1 ? "e" : "i"} in attesa`}
                              style={{
                                backgroundColor: "rgba(255,157,36,0.16)",
                                color: "var(--color-primary-light)",
                              }}
                            >
                              <Bell size={14} aria-hidden="true" />
                              {pendingCount}
                            </span>
                          )}
                        </div>

                        {/* Action buttons - visible on hover */}
                        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg border border-white/[0.06] bg-neutral-elevated/95 p-1 opacity-0 shadow-lg group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200">
                          {/* Rename button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(ws.id, ws.name);
                            }}
                            className="ui-icon-button w-9 h-9 rounded-lg"
                            style={{ color: "var(--color-neutral-text-muted)" }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor =
                                "rgba(255,255,255,0.08)";
                              e.currentTarget.style.color =
                                "var(--color-neutral-text)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = "transparent";
                              e.currentTarget.style.color =
                                "var(--color-neutral-text-muted)";
                            }}
                            title="Rinomina workspace"
                          >
                            <Pencil size={18} />
                          </button>

                          {/* Delete button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(ws.id);
                            }}
                            className="ui-icon-button w-9 h-9 rounded-lg"
                            style={{ color: "var(--color-neutral-text-muted)" }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor =
                                "rgba(239,68,68,0.12)";
                              e.currentTarget.style.color = "#ef4444";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = "transparent";
                              e.currentTarget.style.color =
                                "var(--color-neutral-text-muted)";
                            }}
                            title="Elimina workspace"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {workspaces.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-4 py-16 text-[1rem] text-center"
                style={{ color: "var(--color-neutral-text-muted)" }}
              >
                Nessun workspace.
              </motion.p>
            )}
          </div>
        </div>

        {/* DEV badge */}
        {IS_DEV && (
          <div className="pb-3 text-center">
            <span className="text-[0.5rem] font-bold tracking-[0.15em] text-red-500/70 uppercase">Dev</span>
          </div>
        )}
      </motion.aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {/* Menu contestuale tasto destro */}
      {contextMenu && (
        <div
          className="fixed z-50 py-2.5 rounded-xl shadow-2xl"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            minWidth: "210px",
            backgroundColor: "var(--color-neutral-elevated)",
            border: "1px solid var(--color-neutral-border)",
          }}
        >
          <button
            onClick={() => {
              const ws = workspaces.find((w) => w.id === contextMenu.workspaceId);
              if (ws) startRename(ws.id, ws.name);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-3.5 px-5 py-3 text-[0.9375rem] text-left transition-colors"
            style={{ color: "var(--color-neutral-text-dim)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            <Pencil size={16} />
            Rinomina
          </button>
          <button
            onClick={() => {
              setConfirmDeleteId(contextMenu.workspaceId);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-3.5 px-5 py-3 text-[0.9375rem] text-left transition-colors"
            style={{ color: "#ef4444" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(239,68,68,0.1)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            <Trash2 size={16} />
            Elimina
          </button>
        </div>
      )}
    </>
  );
}
