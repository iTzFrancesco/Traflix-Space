import { useWorkspaceStore, Workspace } from "../../stores/workspaceStore";

interface SpaceCardProps {
  workspace: Workspace;
}

export function SpaceCard({ workspace }: SpaceCardProps) {
  const { setActiveWorkspace } = useWorkspaceStore();

  return (
    <button
      onClick={() => setActiveWorkspace(workspace.id)}
      className="flex flex-col gap-1 w-full px-3 py-3 rounded-lg hover:bg-white/[0.025] transition-colors text-left"
    >
      <span className="text-sm font-medium text-neutral-text truncate">
        {workspace.name}
      </span>
      <span className="text-xs text-neutral-text-muted">
        {workspace.terminalCount} terminali · {workspace.agentCount} agenti
      </span>
    </button>
  );
}
