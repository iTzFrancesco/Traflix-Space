import { useState } from "react";
import {
  Plus,
  FolderOpen,
  Monitor,
  Settings,
  ChevronRight,
  Bot,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";
import { SettingsModal } from "./SettingsModal";
import { AGENTS } from "../../lib/agents";

export function Sidebar() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } =
    useWorkspaceStore();
  const terminalStore = useTerminalStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const allTerminals = Array.from(terminalStore.terminals.values());

  return (
    <>
      <motion.aside
        layout
        className="flex flex-col w-sidebar h-full bg-neutral-bg border-r select-none"
        style={{ borderColor: "var(--neutral-border)" }}
      >
        <div className="p-4">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-neutral-text bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
          >
            <Plus size={16} className="text-primary" />
            Nuovo Spazio
          </motion.button>
        </div>

        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 px-1 mb-2">
            <FolderOpen size={12} className="text-neutral-text-muted" />
            <span className="text-[0.6875rem] font-body font-bold uppercase tracking-wider text-neutral-text-muted">
              Workspace
            </span>
          </div>

          <div className="space-y-1">
            <AnimatePresence mode="popLayout">
              {workspaces.map((ws) => (
                <motion.button
                  key={ws.id}
                  layout
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  onClick={() => setActiveWorkspace(ws.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded-lg transition-colors ${
                    activeWorkspaceId === ws.id
                      ? "bg-neutral-elevated text-neutral-text border-l-2 border-primary"
                      : "text-neutral-text-dim hover:bg-white/[0.025]"
                  }`}
                >
                  <ChevronRight size={14} className="text-neutral-text-muted" />
                  <span className="truncate">{ws.name}</span>
                </motion.button>
              ))}
            </AnimatePresence>

            {workspaces.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-3 py-4 text-xs text-neutral-text-muted text-center"
              >
                Nessun workspace. Crea il tuo primo spazio.
              </motion.p>
            )}
          </div>
        </div>

        <div className="px-4 pb-2 mt-4">
          <div className="flex items-center gap-2 px-1 mb-2">
            <Monitor size={12} className="text-neutral-text-muted" />
            <span className="text-[0.6875rem] font-body font-bold uppercase tracking-wider text-neutral-text-muted">
              Terminali
            </span>
          </div>

          <div className="space-y-1">
            <AnimatePresence mode="popLayout">
              {allTerminals.length === 0 ? (
                <motion.p
                  key="empty-terminals"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-4 text-xs text-neutral-text-muted text-center"
                >
                  Nessun terminale attivo.
                </motion.p>
              ) : (
                allTerminals.map((t) => {
                  const agent = t.agent ? AGENTS.find((a) => a.id === t.agent) : null;
                  return (
                    <motion.div
                      key={t.id}
                      layout
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8, height: 0 }}
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-neutral-text-dim"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <span className="truncate flex-1">{t.title}</span>
                      {agent && (
                        <span
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[0.6rem] font-medium shrink-0"
                          style={{
                            backgroundColor: `${agent.color}18`,
                            color: agent.color,
                          }}
                        >
                          <Bot size={8} />
                          {agent.name}
                        </span>
                      )}
                    </motion.div>
                  );
                })
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="mt-auto p-4 border-t" style={{ borderColor: "var(--neutral-border)" }}>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-text-muted rounded-lg hover:bg-white/[0.025] transition-colors"
          >
            <Settings size={16} />
            Settings
          </motion.button>
        </div>
      </motion.aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
