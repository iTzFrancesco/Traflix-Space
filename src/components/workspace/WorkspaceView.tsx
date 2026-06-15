import { useWorkspaceStore } from "../../stores/workspaceStore";
import { TerminalSquare } from "lucide-react";

export function WorkspaceView() {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-neutral-text-muted">
        <TerminalSquare size={64} strokeWidth={1} className="text-primary/30" />
        <div className="text-center">
          <h2 className="font-display font-bold text-xl text-neutral-text-dim mb-2">
            Nessun Workspace Aperto
          </h2>
          <p className="text-sm max-w-md">
            Seleziona un workspace dalla sidebar o creane uno nuovo per iniziare.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display font-bold text-lg text-neutral-text">
          {workspace.name}
        </h1>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-xs font-medium text-neutral-text-muted bg-neutral-elevated rounded-lg hover:bg-white/5 transition-colors">
            Grid
          </button>
          <button className="px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 rounded-lg hover:bg-primary/20 transition-colors">
            + Terminale
          </button>
        </div>
      </div>

      <div className="flex-1 rounded-pane border bg-neutral-surface p-4 grid place-items-center"
        style={{ borderColor: "var(--neutral-border)" }}
      >
        <p className="text-sm text-neutral-text-muted">
          Terminali in arrivo nella prossima fase...
        </p>
      </div>
    </div>
  );
}
