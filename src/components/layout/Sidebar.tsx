import { useState, useRef, useEffect } from "react";
import { Plus, Pencil, Check, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
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
  const { workspaces, activeWorkspaceId, setActiveWorkspace, updateWorkspace } =
    useWorkspaceStore();
  const terminalStore = useTerminalStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const allTerminals = Array.from(terminalStore.terminals.values());

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
        {/* Top section - New workspace button */}
        <div className="px-4 pt-5 pb-2">
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setWizardOpen(true)}
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-[0.8125rem] font-medium rounded-xl transition-all duration-200"
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
                const terminalCount = allTerminals.filter(
                  (t) => t.workspaceId === ws.id,
                ).length;
                const isRenaming = renamingId === ws.id;

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
                    ) : (
                      /* Normal workspace item */
                      <motion.button
                        onClick={() => setActiveWorkspace(ws.id)}
                        className="flex items-center gap-2.5 w-full px-2.5 py-2.5 rounded-xl transition-all duration-200 group"
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

                        {/* Edit button - visible on hover */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(ws.id, ws.name);
                          }}
                          className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200"
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
                      </motion.button>
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
