import { useEffect, useState, useRef, useCallback } from "react";
import { TerminalSquare, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { WorkspaceGrid } from "./WorkspaceGrid";
import { NewSpaceWizard } from "./NewSpaceWizard";
import type { TerminalConfig } from "../../stores/terminalStore";

interface LoadedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  layout: { rows: number; cols: number };
  terminals: TerminalConfig[];
}

export function WorkspaceView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const addToast = useToastStore((s) => s.addToast);
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);
  const wizardOpen = useUIStore((s) => s.wizardOpen);

  const MAX_OPEN_WORKSPACES = 8;

  const [loadedMap, setLoadedMap] = useState<Map<string, LoadedWorkspace>>(
    () => new Map(),
  );
  const loadedMapRef = useRef(loadedMap);
  loadedMapRef.current = loadedMap;
  const loadingRef = useRef<Set<string>>(new Set());
  const openOrderRef = useRef<string[]>([]);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const activeLoaded = activeWorkspaceId
    ? loadedMap.get(activeWorkspaceId)
    : undefined;

  const loadWorkspace = useCallback((id: string) => {
    if (loadedMapRef.current.has(id) || loadingRef.current.has(id)) return;
    loadingRef.current.add(id);

    let cancelled = false;

    invokeWithTimeout(
      () =>
        invoke<{
          id: string;
          name: string;
          rootPath: string;
          layout: { rows: number; cols: number };
          terminals: TerminalConfig[];
        }>("get_workspace", { id }),
      15000,
    )
      .then((fullConfig) => {
        if (cancelled) return;

        // Registra i terminali nel terminalStore
        const terminalStore = useTerminalStore.getState();
        for (const tc of fullConfig.terminals || []) {
          if (!terminalStore.terminals.has(tc.id)) {
            terminalStore.createTerminal({
              id: tc.id,
              workspaceId: id,
              shell: tc.shell,
              cwd: tc.cwd,
              title: tc.title,
              process: tc.shell,
              agent: tc.agentId || null,
            });
          }
        }

        setLoadedMap((prev) => {
          const next = new Map(prev);
          next.set(id, {
            id: fullConfig.id,
            name: fullConfig.name,
            rootPath: fullConfig.rootPath,
            layout: fullConfig.layout,
            terminals: fullConfig.terminals || [],
          });

          openOrderRef.current = openOrderRef.current
            .filter((k) => k !== id)
            .concat(id);

          if (next.size > MAX_OPEN_WORKSPACES) {
            const currentActive = useWorkspaceStore.getState().activeWorkspaceId;
            const toEvict = openOrderRef.current.find(
              (k) => k !== currentActive && next.has(k),
            );
            if (toEvict) {
              terminalStore.killWorkspaceTerminals(toEvict);
              next.delete(toEvict);
              openOrderRef.current = openOrderRef.current.filter(
                (k) => k !== toEvict,
              );
            }
          }

          return next;
        });
      })
      .catch((err) => {
        console.error("Errore caricamento workspace:", err);
        addToastRef.current({
          type: "error",
          message: "Errore caricamento workspace",
        });
      })
      .finally(() => {
        loadingRef.current.delete(id);
      });

    return () => {
      cancelled = true;
      loadingRef.current.delete(id);
    };
  }, []);

  // Carica il workspace attivo e cleanup terminali del precedente
  useEffect(() => {
    if (!activeWorkspaceId) return;

    const terminalStore = useTerminalStore.getState();
    for (const id of loadedMapRef.current.keys()) {
      if (id !== activeWorkspaceId) {
        terminalStore.killWorkspaceTerminals(id);
      }
    }

    loadWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, loadWorkspace]);

  // Pulisci i workspace rimossi dalla mappa — osserva tutto l'array workspaces
  useEffect(() => {
    const allIds = new Set(workspaces.map((w) => w.id));
    const terminalStore = useTerminalStore.getState();
    setLoadedMap((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!allIds.has(key)) {
          terminalStore.killWorkspaceTerminals(key);
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspaces]);

  // Empty state — nessun workspace aperto
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-full gap-6 text-neutral-text-muted">
          <TerminalSquare
            size={64}
            strokeWidth={1}
            className="text-primary/30"
          />
          <div className="text-center">
            <h2 className="font-display font-bold text-xl text-neutral-text-dim mb-2">
              Nessun Workspace Aperto
            </h2>
            <p className="text-sm max-w-md mb-6">
              Seleziona un workspace dalla sidebar o creane uno nuovo per
              iniziare.
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
        <NewSpaceWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
        />
      </>
    );
  }

  // Loading iniziale — workspace selezionato ma non ancora caricato
  if (!activeLoaded) return null;

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
        {/* Header del workspace attivo */}
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
            {activeLoaded.name}
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
            {activeLoaded.rootPath}
          </p>
        </div>

        {/* Solo il workspace attivo viene renderizzato */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <WorkspaceGrid
              rows={activeLoaded.layout.rows}
              cols={activeLoaded.layout.cols}
              terminals={activeLoaded.terminals}
            />
          </div>
        </div>
      </div>
      <NewSpaceWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
      />
    </>
  );
}
