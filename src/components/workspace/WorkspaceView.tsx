import { useEffect, useState, useRef, useCallback } from "react";
import { TerminalSquare, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { computeLayout } from "../../lib/presets";
import { WorkspaceGrid } from "./WorkspaceGrid";
import { NewSpaceWizard } from "./NewSpaceWizard";
import type { TerminalConfig } from "../../stores/terminalStore";

interface LoadedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  layout: { rows: number; cols: number };
  terminals: TerminalConfig[];
  createdAt: string;
  updatedAt: string;
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
        let firstId: string | null = null;
        for (const tc of fullConfig.terminals || []) {
          if (!terminalStore.terminals[tc.id]) {
            terminalStore.addTerminal({
              id: tc.id,
              workspaceId: id,
              shell: tc.shell,
              cwd: tc.cwd,
              title: tc.title,
              agent: tc.agentId || null,
            });
          }
          if (!firstId) firstId = tc.id;
        }

        // Auto-attiva il primo terminale
        if (firstId) {
          terminalStore.setActiveTerminal(firstId);
        }

        setLoadedMap((prev) => {
          const next = new Map(prev);
          next.set(id, {
            id: fullConfig.id,
            name: fullConfig.name,
            rootPath: fullConfig.rootPath,
            layout: fullConfig.layout,
            terminals: fullConfig.terminals || [],
            createdAt: (fullConfig as any).createdAt ?? new Date().toISOString(),
            updatedAt: (fullConfig as any).updatedAt ?? new Date().toISOString(),
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

  // Gestisce la chiusura di un terminale: kill backend, rimuovi da config, aggiorna layout
  const handleCloseTerminal = useCallback(async (terminalId: string) => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;

    // 1. Kill backend session
    await invokeWithTimeout(
      () => invoke("terminal_kill", { terminalId }),
      5000,
    ).catch(() => {});

    // 2. Rimuovi dal terminal store
    useTerminalStore.getState().removeTerminal(terminalId);

    // 3. Aggiorna loadedMap e workspace config
    const current = loadedMapRef.current.get(workspaceId);
    if (!current) return;

    const newTerminals = current.terminals.filter((t) => t.id !== terminalId);
    const newLayout = computeLayout(newTerminals.length);

    // 4. Aggiorna backend
    const updatedConfig = {
      id: workspaceId,
      name: current.name,
      rootPath: current.rootPath,
      layout: newLayout,
      terminals: newTerminals,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    try {
      await invokeWithTimeout(
        () => invoke("update_workspace", { id: workspaceId, config: updatedConfig }),
        10000,
      );
    } catch (err) {
      console.error("Errore aggiornamento workspace:", err);
    }

    // 5. Aggiorna loadedMap
    setLoadedMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(workspaceId);
      if (existing) {
        next.set(workspaceId, {
          ...existing,
          terminals: newTerminals,
          layout: newLayout,
        });
      }
      return new Map(next);
    });

    // 6. Aggiorna workspace store (per la sidebar)
    const agentCount = newTerminals.filter((t) => t.agentId).length;
    useWorkspaceStore.getState().updateWorkspace(workspaceId, {
      terminalCount: newTerminals.length,
      agentCount,
    });
  }, [activeWorkspaceId]);

  // Esponi handleCloseTerminal globalmente per la keyboard shortcut
  const closeTerminalRef = useRef(handleCloseTerminal);
  closeTerminalRef.current = handleCloseTerminal;
  useEffect(() => {
    (window as any).__traflix_close_terminal = () => {
      const store = useTerminalStore.getState();
      const activeId = store.activeTerminalId;
      if (activeId) {
        closeTerminalRef.current(activeId);
      }
    };
    return () => {
      delete (window as any).__traflix_close_terminal;
    };
  }, []);

  // Carica workspace attivo se non già in cache
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (!loadedMapRef.current.has(activeWorkspaceId)) {
      loadWorkspace(activeWorkspaceId);
    }
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
              onActivate={(id) => {
                useTerminalStore.getState().setActiveTerminal(id);
              }}
              onCloseTerminal={handleCloseTerminal}
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
