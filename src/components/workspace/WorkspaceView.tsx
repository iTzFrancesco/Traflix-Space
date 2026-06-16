import { useEffect, useState, useRef } from "react";
import { TerminalSquare, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { WorkspaceGrid } from "./WorkspaceGrid";
import { NewSpaceWizard } from "./NewSpaceWizard";
import type { TerminalConfig } from "../../stores/terminalStore";

export function WorkspaceView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const addToast = useToastStore((s) => s.addToast);
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);
  const wizardOpen = useUIStore((s) => s.wizardOpen);
  const [configTerminals, setConfigTerminals] = useState<TerminalConfig[]>([]);
  const loadedForRef = useRef<string | null>(null);

  // Stabilità: ricordiamo l'ultimo workspace valido per evitare flash di "nessun workspace"
  const lastValidWorkspace = useRef<any>(null);
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  if (workspace) {
    lastValidWorkspace.current = workspace;
  }

  const displayWorkspace = workspace || lastValidWorkspace.current;

  useEffect(() => {
    if (!activeWorkspaceId) {
      loadedForRef.current = null;
      setConfigTerminals([]);
      lastValidWorkspace.current = null;
      return;
    }

    if (loadedForRef.current === activeWorkspaceId) return;
    loadedForRef.current = activeWorkspaceId;

    let cancelled = false;

    invokeWithTimeout(
      () =>
        invoke<{
          id: string;
          name: string;
          rootPath: string;
          layout: { rows: number; cols: number };
          terminals: TerminalConfig[];
        }>("get_workspace", { id: activeWorkspaceId }),
      15000,
    )
      .then((fullConfig) => {
        if (!cancelled) {
          setConfigTerminals(fullConfig.terminals || []);
        }
      })
      .catch((err) => {
        console.error("Errore caricamento workspace:", err);
        addToastRef.current({
          type: "error",
          message: "Errore caricamento workspace",
        });
        if (!cancelled) setConfigTerminals([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  if (!displayWorkspace && !activeWorkspaceId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 text-neutral-text-muted">
        <TerminalSquare size={64} strokeWidth={1} className="text-primary/30" />
        <div className="text-center">
          <h2 className="font-display font-bold text-xl text-neutral-text-dim mb-2">
            Nessun Workspace Aperto
          </h2>
          <p className="text-sm max-w-md mb-6">
            Seleziona un workspace dalla sidebar o creane uno nuovo per iniziare.
          </p>
          <button
            onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-2 px-6 py-3 text-sm font-bold text-white rounded-xl transition-all duration-200 active:scale-[0.97]"
            style={{
              background: "linear-gradient(135deg, #e85d04, #ff7b00)",
              boxShadow: "0 4px 16px rgba(232, 93, 4, 0.25)",
            }}
          >
            <Plus size={16} />
            Nuovo Spazio
          </button>
        </div>
      </div>
    );
  }

  // Se abbiamo un activeWorkspaceId ma displayWorkspace è ancora null,
  // carichiamo silenziosamente per evitare unmount
  if (!displayWorkspace) return null;

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
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
            {displayWorkspace.name}
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
            {displayWorkspace.rootPath}
          </p>
        </div>

        <WorkspaceGrid
          rows={displayWorkspace.layout.rows}
          cols={displayWorkspace.layout.cols}
          terminals={configTerminals}
        />
      </div>
      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
