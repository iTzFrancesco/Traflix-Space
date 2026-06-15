import { useState } from "react";
import {
  Plus,
  FolderOpen,
  Monitor,
  Settings,
  ChevronRight,
} from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";

export function Sidebar() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } =
    useWorkspaceStore();
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
      <aside className="flex flex-col w-sidebar h-full bg-neutral-bg border-r select-none"
        style={{ borderColor: "var(--neutral-border)" }}
      >
        <div className="p-4">
          <button
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-neutral-text bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
          >
            <Plus size={16} className="text-primary" />
            Nuovo Spazio
          </button>
        </div>

      <div className="px-4 pb-2">
        <div className="flex items-center gap-2 px-1 mb-2">
          <FolderOpen size={12} className="text-neutral-text-muted" />
          <span className="text-[0.6875rem] font-body font-bold uppercase tracking-wider text-neutral-text-muted">
            Workspace
          </span>
        </div>

        <div className="space-y-1">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setActiveWorkspace(ws.id)}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded-lg transition-colors ${
                activeWorkspaceId === ws.id
                  ? "bg-neutral-elevated text-neutral-text border-l-2 border-primary"
                  : "text-neutral-text-dim hover:bg-white/[0.025]"
              }`}
            >
              <ChevronRight size={14} className="text-neutral-text-muted" />
              <span className="truncate">{ws.name}</span>
            </button>
          ))}

          {workspaces.length === 0 && (
            <p className="px-3 py-4 text-xs text-neutral-text-muted text-center">
              Nessun workspace. Crea il tuo primo spazio.
            </p>
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
          <p className="px-3 py-4 text-xs text-neutral-text-muted text-center">
            Nessun terminale attivo.
          </p>
        </div>
      </div>

      <div className="mt-auto p-4 border-t" style={{ borderColor: "var(--neutral-border)" }}>
        <button className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-text-muted rounded-lg hover:bg-white/[0.025] transition-colors">
          <Settings size={16} />
          Settings
        </button>
      </div>
    </aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
