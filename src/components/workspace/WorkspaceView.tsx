import { useMemo, useEffect, useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminal } from "../../hooks/useTerminal";
import { useToastStore } from "../../stores/toastStore";
import { WorkspaceGrid } from "./WorkspaceGrid";
import type { TerminalConfig } from "../../stores/terminalStore";

export function WorkspaceView() {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const terminalStore = useTerminalStore();
  const terminalHook = useTerminal();
  const { addToast } = useToastStore();
  const [configTerminals, setConfigTerminals] = useState<TerminalConfig[]>([]);
  const initializedRef = useRef<string | null>(null);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setConfigTerminals([]);
      initializedRef.current = null;
      return;
    }

    let cancelled = false;

    invoke<{
      id: string;
      name: string;
      rootPath: string;
      layout: { rows: number; cols: number };
      terminals: TerminalConfig[];
    }>("get_workspace", { id: activeWorkspaceId })
      .then((fullConfig) => {
        if (!cancelled) {
          setConfigTerminals(fullConfig.terminals || []);
        }
      })
      .catch((err) => {
        console.error("Errore caricamento workspace:", err);
        addToast({ type: "error", message: "Errore caricamento workspace" });
        if (!cancelled) setConfigTerminals([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const workspaceTerminals = useMemo(
    () =>
      Array.from(terminalStore.terminals.values()).filter(
        (t) => t.workspaceId === activeWorkspaceId,
      ),
    [terminalStore.terminals, activeWorkspaceId],
  );

  const hasStoreTerminals = workspaceTerminals.length > 0;

  const displayTerminals = useMemo(() => {
    if (hasStoreTerminals) {
      return workspaceTerminals.map((t) => ({
        id: t.id,
        shell: t.shell,
        agentId: t.agent,
        command: null as string | null,
        cwd: t.cwd,
        title: t.title,
      }));
    }

    return configTerminals.map((ct) => ({
      id: ct.id,
      shell: ct.shell,
      agentId: ct.agentId || null,
      command: ct.command || null,
      cwd: ct.cwd,
      title: ct.title,
    }));
  }, [hasStoreTerminals, workspaceTerminals, configTerminals]);

  useEffect(() => {
    if (!activeWorkspaceId || configTerminals.length === 0) return;
    if (hasStoreTerminals) return;
    if (initializedRef.current === activeWorkspaceId) return;

    initializedRef.current = activeWorkspaceId;

    for (const ct of configTerminals) {
      terminalHook.create({
        workspaceId: activeWorkspaceId,
        shell: ct.shell,
        cwd: ct.cwd,
        title: ct.title,
        agent: ct.agentId || null,
      });
    }
  }, [activeWorkspaceId, configTerminals, hasStoreTerminals, terminalHook]);

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "12px 20px 8px", flexShrink: 0 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "16px",
            color: "#f4f4f5",
            letterSpacing: "-0.01em",
          }}
        >
          {workspace.name}
        </h1>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "#52525b",
            marginTop: "2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {workspace.rootPath}
        </p>
      </div>

      <WorkspaceGrid
        rows={workspace.layout.rows}
        cols={workspace.layout.cols}
        terminals={displayTerminals}
      />
    </div>
  );
}
