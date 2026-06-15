import { useWorkspaceStore } from "../../stores/workspaceStore";

export function WorkspaceTabs() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } =
    useWorkspaceStore();

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      {workspaces.map((ws) => (
        <button
          key={ws.id}
          onClick={() => setActiveWorkspace(ws.id)}
          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
            activeWorkspaceId === ws.id
              ? "bg-neutral-elevated text-neutral-text"
              : "text-neutral-text-muted hover:text-neutral-text-dim"
          }`}
        >
          {ws.name}
        </button>
      ))}
    </div>
  );
}
