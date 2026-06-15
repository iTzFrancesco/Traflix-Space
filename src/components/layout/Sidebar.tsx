import { useState } from "react";
import {
  Plus,
  Terminal,
  Bot,
  Pencil,
  Check,
  X,
  ArrowUpRight,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";
import { AGENTS } from "../../lib/agents";

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
  const { workspaces, activeWorkspaceId, setActiveWorkspace } =
    useWorkspaceStore();
  const terminalStore = useTerminalStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [renamingTerminalId, setRenamingTerminalId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");

  const allTerminals = Array.from(terminalStore.terminals.values());

  const startRename = (terminalId: string, currentTitle: string) => {
    setRenamingTerminalId(terminalId);
    setRenameValue(currentTitle);
  };

  const confirmRename = (terminalId: string) => {
    if (renameValue.trim()) {
      terminalStore.updateTerminalTitle(terminalId, renameValue.trim());
    }
    setRenamingTerminalId(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenamingTerminalId(null);
    setRenameValue("");
  };

  const navigateToWorkspace = (workspaceId: string) => {
    setActiveWorkspace(workspaceId);
  };

  return (
    <>
      <motion.aside
        layout
        className="flex flex-col w-sidebar h-full bg-neutral-bg border-r select-none"
        style={{ borderColor: "var(--neutral-border)" }}
      >
        {/* Create new workspace button */}
        <div className="p-3 pb-0">
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-neutral-text-dim bg-white/[0.04] rounded-lg hover:bg-white/[0.07] transition-colors"
          >
            <Plus size={14} className="text-neutral-text-muted" />
            Nuovo Spazio
          </motion.button>
        </div>

        {/* Workspaces section */}
        <div className="flex-1 overflow-y-auto px-2 pt-4 pb-2">
          <div className="flex items-center gap-2 px-2 mb-2">
            <span className="text-[0.65rem] font-body font-semibold uppercase tracking-widest text-neutral-text-muted">
              Workspaces
            </span>
          </div>

          <div className="space-y-0.5">
            <AnimatePresence mode="popLayout">
              {workspaces.map((ws, index) => {
                const color = getWorkspaceColor(index);
                const isActive = activeWorkspaceId === ws.id;
                const terminalCount = allTerminals.filter(
                  (t) => t.workspaceId === ws.id,
                ).length;

                return (
                  <motion.button
                    key={ws.id}
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    onClick={() => setActiveWorkspace(ws.id)}
                    className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-lg transition-all group ${
                      isActive
                        ? "bg-white/[0.06]"
                        : "hover:bg-white/[0.03]"
                    }`}
                    style={{
                      borderLeft: `2.5px solid ${isActive ? color : "transparent"}`,
                    }}
                  >
                    {/* Colored square icon */}
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${color}20` }}
                    >
                      <div
                        className="w-2 h-2 rounded-sm"
                        style={{ backgroundColor: color }}
                      />
                    </div>

                    {/* Workspace name */}
                    <span
                      className={`truncate text-[0.8125rem] flex-1 text-left ${
                        isActive
                          ? "text-neutral-text font-medium"
                          : "text-neutral-text-dim"
                      }`}
                    >
                      {ws.name}
                    </span>

                    {/* Terminal count badge */}
                    {terminalCount > 0 && (
                      <span
                        className="text-[0.625rem] font-mono font-medium px-1.5 py-0.5 rounded-md shrink-0"
                        style={{
                          backgroundColor: `${color}15`,
                          color: color,
                        }}
                      >
                        {terminalCount}
                      </span>
                    )}
                  </motion.button>
                );
              })}
            </AnimatePresence>

            {workspaces.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-3 py-6 text-xs text-neutral-text-muted text-center"
              >
                Nessun workspace.
              </motion.p>
            )}
          </div>
        </div>

        {/* Terminals section */}
        <div
          className="border-t px-2 py-3"
          style={{ borderColor: "var(--neutral-border)" }}
        >
          <div className="flex items-center gap-2 px-2 mb-2">
            <Terminal size={11} className="text-neutral-text-muted" />
            <span className="text-[0.65rem] font-body font-semibold uppercase tracking-widest text-neutral-text-muted">
              Terminali
            </span>
          </div>

          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            <AnimatePresence mode="popLayout">
              {allTerminals.length === 0 ? (
                <motion.p
                  key="empty-terminals"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-4 text-[0.6875rem] text-neutral-text-muted text-center"
                >
                  Nessun terminale attivo.
                </motion.p>
              ) : (
                allTerminals.map((t) => {
                  const agent = t.agent
                    ? AGENTS.find((a) => a.id === t.agent)
                    : null;
                  const isRenaming = renamingTerminalId === t.id;
                  const wsColor =
                    WORKSPACE_COLORS[
                      workspaces.findIndex((w) => w.id === t.workspaceId) %
                        WORKSPACE_COLORS.length
                    ] || "#71717a";

                  return (
                    <motion.div
                      key={t.id}
                      layout
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6, height: 0 }}
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.03] group transition-colors"
                    >
                      {/* Active dot */}
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: wsColor }}
                      />

                      {isRenaming ? (
                        /* Rename input */
                        <div className="flex items-center gap-1 flex-1">
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") confirmRename(t.id);
                              if (e.key === "Escape") cancelRename();
                            }}
                            autoFocus
                            className="flex-1 bg-white/[0.06] text-neutral-text text-[0.75rem] px-1.5 py-0.5 rounded outline-none border border-white/10 focus:border-primary/40"
                          />
                          <button
                            onClick={() => confirmRename(t.id)}
                            className="p-0.5 text-green-400 hover:text-green-300"
                          >
                            <Check size={12} />
                          </button>
                          <button
                            onClick={cancelRename}
                            className="p-0.5 text-neutral-text-muted hover:text-neutral-text"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        /* Terminal display */
                        <>
                          <span className="truncate flex-1 text-[0.75rem] text-neutral-text-dim">
                            {t.title}
                          </span>

                          {agent && (
                            <span
                              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[0.5625rem] font-medium shrink-0"
                              style={{
                                backgroundColor: `${agent.color}18`,
                                color: agent.color,
                              }}
                            >
                              <Bot size={7} />
                              {agent.name}
                            </span>
                          )}

                          {/* Action buttons on hover */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startRename(t.id, t.title);
                              }}
                              className="p-0.5 text-neutral-text-muted hover:text-neutral-text"
                              title="Rinomina"
                            >
                              <Pencil size={10} />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateToWorkspace(t.workspaceId);
                              }}
                              className="p-0.5 text-neutral-text-muted hover:text-neutral-text"
                              title="Vai al workspace"
                            >
                              <ArrowUpRight size={10} />
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  );
                })
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
