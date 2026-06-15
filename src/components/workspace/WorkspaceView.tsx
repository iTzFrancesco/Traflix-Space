import { useEffect, useState, useRef } from "react";
import { TerminalSquare } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { WorkspaceGrid } from "./WorkspaceGrid";
import type { TerminalConfig } from "../../stores/terminalStore";

export function WorkspaceView() {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const { addToast } = useToastStore();
  const [configTerminals, setConfigTerminals] = useState<TerminalConfig[]>([]);
  const loadedForRef = useRef<string | null>(null);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setConfigTerminals([]);
      loadedForRef.current = null;
      return;
    }
    
    if (loadedForRef.current === activeWorkspaceId) return;
    loadedForRef.current = activeWorkspaceId;

    invoke<{ terminals: TerminalConfig[] }>("get_workspace", { id: activeWorkspaceId })
      .then((fullConfig) => {
        setConfigTerminals(fullConfig.terminals || []);
      })
      .catch(() => {
        addToast({ type: "error", message: "Errore caricamento workspace" });
      });
  }, [activeWorkspaceId, addToast]);

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
        terminals={configTerminals}
      />
    </div>
  );
}
