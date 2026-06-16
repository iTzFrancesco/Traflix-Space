import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";

const WORKSPACE_COLORS = [
  "#e85d04",
  "#06b6d4",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#3b82f6",
];

function getWorkspaceColor(index: number): string {
  return WORKSPACE_COLORS[index % WORKSPACE_COLORS.length];
}

export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const isCollapsed = useUIStore((s) => s.isCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const wizardOpen = useUIStore((s) => s.wizardOpen);
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  /* ─── Collapsed mode: compact dots ─── */
  if (isCollapsed) {
    return (
      <>
        <motion.aside
          layout
          className="flex flex-col items-center h-full select-none py-4 gap-3"
          style={{
            width: "52px",
            backgroundColor: "var(--color-neutral-surface)",
            borderRight: "1px solid var(--color-neutral-border)",
          }}
        >
          {/* Expand button */}
          <motion.div
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
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
            <PanelLeftOpen size={15} />
          </motion.div>

          {/* New workspace dot */}
          <motion.div
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.9 }}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-200 cursor-pointer"
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
            <Plus size={14} />
          </motion.div>

          {/* Divider */}
          <div
            className="w-4 h-px"
            style={{ backgroundColor: "var(--color-neutral-border)" }}
          />

          {/* Workspace dots */}
          <div className="flex flex-col items-center gap-2 flex-1 overflow-y-auto">
            {workspaces.map((ws, index) => {
              const color = getWorkspaceColor(index);
              const isActive = activeWorkspaceId === ws.id;

              return (
                <motion.button
                  key={ws.id}
                  whileHover={{ scale: 1.2 }}
                  whileTap={{ scale: 0.85 }}
                  onClick={() => setActiveWorkspace(ws.id)}
                  className="relative w-3 h-3 rounded-full transition-all duration-200"
                  style={{
                    backgroundColor: color,
                    boxShadow: isActive
                      ? `0 0 0 2px var(--color-neutral-surface), 0 0 0 3.5px ${color}`
                      : "none",
                  }}
                  title={ws.name}
                />
              );
            })}
          </div>
        </motion.aside>

        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

  /* ─── Expanded mode: full sidebar ─── */
  return (
    <>
      <motion.aside
        layout
        className="flex flex-col w-sidebar h-full select-none"
        style={{
          backgroundColor: "var(--color-neutral-surface)",
          borderRight: "1px solid var(--color-neutral-border)",
        }}
      >
        {/* Top section - Collapse button + New workspace */}
        <div className="flex items-center gap-1.5 px-4 pt-5 pb-2">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={toggleSidebar}
            className="p-1.5 rounded-lg transition-colors duration-200 shrink-0"
            style={{ color: "var(--color-neutral-text-muted)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
            title="Comprimi sidebar"
          >
            <PanelLeftClose size={15} />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setWizardOpen(true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-[0.8125rem] font-medium rounded-xl transition-all duration-200"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              color: "var(--color-neutral-text-dim)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.07)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
            }}
          >
            <Plus size={15} style={{ color: "var(--color-primary)" }} />
            Nuovo Spazio
          </motion.button>
        </div>

        {/* Workspaces section */}
        <div className="flex-1 overflow-y-auto px-3 pt-4 pb-4">
          {/* Section header */}
          <div className="flex items-center gap-2 px-2 mb-3">
            <span
              className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]"
              style={{
                fontFamily: "var(--font-display)",
                color: "var(--color-neutral-text-muted)",
              }}
            >
              Workspaces
            </span>
          </div>

          {/* Workspace list */}
          <div className="space-y-1">
            <AnimatePresence mode="popLayout">
              {workspaces.map((ws, index) => {
                const color = getWorkspaceColor(index);
                const isActive = activeWorkspaceId === ws.id;
                const terminalCount = ws.terminalCount;
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
                        className="flex items-center gap-2 px-2.5 py-2 rounded-xl"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.06)",
                          borderLeft: `2.5px solid ${color}`,
                        }}
                      >
                        <div
                          className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${color}18` }}
                        >
                          <div
                            className="w-2.5 h-2.5 rounded"
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
                          className="flex-1 bg-transparent text-[0.8125rem] font-medium outline-none border-b border-white/20 pb-0.5"
                          style={{ color: "var(--color-neutral-text)" }}
                        />
                        <button
                          onClick={() => confirmRename(ws.id)}
                          className="p-1 rounded-md transition-colors"
                          style={{ color: "#10b981" }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(16,185,129,0.15)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                        >
                          <Check size={13} />
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-1 rounded-md transition-colors"
                          style={{ color: "var(--color-neutral-text-muted)" }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.06)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : isDeleting ? (
                      /* Delete confirmation mode */
                      <div
                        className="flex items-center gap-2 px-2.5 py-2 rounded-xl"
                        style={{
                          backgroundColor: "rgba(239,68,68,0.08)",
                          borderLeft: `2.5px solid #ef4444`,
                        }}
                      >
                        <span
                          className="flex-1 text-[0.75rem] truncate"
                          style={{ color: "var(--color-neutral-text-dim)" }}
                        >
                          Eliminare "{ws.name}"?
                        </span>
                        <button
                          onClick={() => handleDelete(ws.id)}
                          className="px-2 py-0.5 rounded-md text-[0.6875rem] font-medium transition-colors"
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
                          className="px-2 py-0.5 rounded-md text-[0.6875rem] font-medium transition-colors"
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            setActiveWorkspace(ws.id);
                          }
                        }}
                        className="flex items-center gap-2.5 w-full px-2.5 py-2.5 rounded-xl transition-all duration-200 group cursor-pointer"
                        style={{
                          backgroundColor: isActive
                            ? "rgba(255,255,255,0.06)"
                            : "transparent",
                          borderLeft: `2.5px solid ${isActive ? color : "transparent"}`,
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive)
                            e.currentTarget.style.backgroundColor =
                              "rgba(255,255,255,0.03)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive)
                            e.currentTarget.style.backgroundColor = "transparent";
                        }}
                      >
                        {/* Colored square icon */}
                        <div
                          className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-105"
                          style={{ backgroundColor: `${color}18` }}
                        >
                          <div
                            className="w-2.5 h-2.5 rounded"
                            style={{ backgroundColor: color }}
                          />
                        </div>

                        {/* Workspace name */}
                        <span
                          className={`truncate text-[0.8125rem] flex-1 text-left ${
                            isActive ? "font-medium" : ""
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
                            className="text-[0.625rem] font-mono font-medium px-1.5 py-0.5 rounded-md shrink-0 transition-opacity duration-200"
                            style={{
                              backgroundColor: `${color}15`,
                              color: color,
                            }}
                          >
                            {terminalCount}
                          </span>
                        )}

                        {/* Action buttons - visible on hover */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          {/* Rename button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(ws.id, ws.name);
                            }}
                            className="p-1 rounded-md transition-colors"
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
                            <Pencil size={12} />
                          </button>

                          {/* Delete button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(ws.id);
                            }}
                            className="p-1 rounded-md transition-colors"
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
                            <Trash2 size={12} />
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
                className="px-3 py-8 text-[0.8125rem] text-center"
                style={{ color: "var(--color-neutral-text-muted)" }}
              >
                Nessun workspace.
              </motion.p>
            )}
          </div>
        </div>
      </motion.aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
