import { useMemo, useCallback } from "react";
import { Plus, TerminalSquare } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
import { WorkspaceGrid } from "./WorkspaceGrid";

export function WorkspaceView() {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const terminalStore = useTerminalStore();
  const terminalHook = useTerminal();

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const workspaceTerminals = useMemo(
    () =>
      Array.from(terminalStore.terminals.values()).filter(
        (t) => t.workspaceId === activeWorkspaceId,
      ),
    [terminalStore.terminals, activeWorkspaceId],
  );

  const workspaceConfig = useMemo(() => {
    if (!activeWorkspaceId) return null;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return null;
    return {
      layout: ws.layout,
      name: ws.name,
      rootPath: ws.rootPath,
    };
  }, [workspaces, activeWorkspaceId]);

  const hasStoreTerminals = workspaceTerminals.length > 0;

  const configTerminals = workspaceConfig
    ? Array.from({ length: workspaceConfig.layout.rows * workspaceConfig.layout.cols }).map(
        (_, i) => ({
          id: `config-${i}`,
          shell: "powershell",
          agentId: null as string | null,
          command: null as string | null,
          cwd: workspaceConfig.rootPath,
          title: `Terminal ${i + 1}`,
        }),
      )
    : [];

  const displayTerminals = hasStoreTerminals
    ? workspaceTerminals.map((t) => ({
        id: t.id,
        shell: t.shell,
        agentId: t.agent,
        command: null as string | null,
        cwd: t.cwd,
        title: t.title,
      }))
    : configTerminals;

  const handleAddTerminal = useCallback(() => {
    if (!activeWorkspaceId || !workspaceConfig) return;
    terminalHook.create({
      workspaceId: activeWorkspaceId,
      shell: "powershell",
      cwd: workspaceConfig.rootPath,
      title: `Terminal ${workspaceTerminals.length + 1}`,
    });
  }, [activeWorkspaceId, workspaceConfig, terminalHook, workspaceTerminals.length]);

  if (!workspace || !workspaceConfig) {
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 pt-4 pb-2 shrink-0">
        <h1 className="font-display font-bold text-lg text-neutral-text">
          {workspace.name}
        </h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-text-muted font-mono">
            {workspaceConfig.layout.rows}x{workspaceConfig.layout.cols}
          </span>
          <button
            onClick={handleAddTerminal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
          >
            <Plus size={14} />
            Terminale
          </button>
        </div>
      </div>

      <WorkspaceGrid
        rows={workspaceConfig.layout.rows}
        cols={workspaceConfig.layout.cols}
        terminals={displayTerminals}
      />
    </div>
  );
}
