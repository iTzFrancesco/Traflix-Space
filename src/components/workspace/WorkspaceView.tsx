import { useEffect, useState, useRef, useCallback } from "react";
import { TerminalSquare, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore } from "../../stores/skillStore";
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

interface TerminalCloseRequest {
  terminalId: string;
  token: number;
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
  const MAX_TERMINALS_PER_WORKSPACE = 8;

  const [loadedMap, setLoadedMap] = useState<Map<string, LoadedWorkspace>>(
    () => new Map(),
  );
  const [closeRequest, setCloseRequest] = useState<TerminalCloseRequest | null>(null);
  const loadedMapRef = useRef(loadedMap);
  loadedMapRef.current = loadedMap;
  const loadingRef = useRef<Set<string>>(new Set());
  const openOrderRef = useRef<string[]>([]);
  // Coda di serializzazione per la chiusura terminali — previene race condition
  const closeQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Ref sincrono della lista terminali (aggiornato subito, non dopo re-render)
  const workspaceTerminalsRef = useRef<TerminalConfig[]>([]);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const activeLoaded = activeWorkspaceId
    ? loadedMap.get(activeWorkspaceId)
    : undefined;
  // Derive the visible grid from the actual pane count. This also migrates
  // workspaces saved with an older layout (notably the previous 2x2 for 3).
  const activeLayout = activeLoaded
    ? computeLayout(activeLoaded.terminals.length)
    : null;

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

        // Calculate eviction BEFORE setState — React may call updaters multiple
        // times (StrictMode, concurrent rendering) so side effects don't belong
        // inside the updater function. Read from refs, not from stale closure.
        const newOrder = openOrderRef.current
          .filter((k) => k !== id)
          .concat(id);

        const currentActive = useWorkspaceStore.getState().activeWorkspaceId;
        const toEvict = loadedMapRef.current.size >= MAX_OPEN_WORKSPACES
          ? newOrder.find(
              (k) => k !== currentActive && loadedMapRef.current.has(k),
            )
          : undefined;

        if (toEvict) {
          terminalStore.killWorkspaceTerminals(toEvict);
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

          openOrderRef.current = newOrder;

          if (toEvict) {
            next.delete(toEvict);
            openOrderRef.current = openOrderRef.current.filter(
              (k) => k !== toEvict,
            );
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

  // Gestisce la chiusura di un terminale: serializzata per evitare race condition.
  // La coda (closeQueueRef) garantisce che due chiusure consecutive non leggano
  // lo stesso stato stale, e workspaceTerminalsRef viene aggiornato
  // sincronicamente dopo ogni filtro, prima della prossima operazione in coda.
  const handleCloseTerminal = useCallback((terminalId: string) => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;

    closeQueueRef.current = closeQueueRef.current
      .then(async () => {
        // Guard: se il workspace non è più attivo, ignora
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

        // 1. Kill backend session
        await invokeWithTimeout(
          () => invoke("terminal_kill", { terminalId }),
          5000,
        ).catch(() => {});

        // 2. Rimuovi dal terminal store (+ clear focus se necessario)
        useSkillStore.getState().clearPendingDrop(terminalId);
        useTerminalStore.getState().removeTerminal(terminalId);

        // 3. Leggi dal ref sincrono (aggiornato dopo ogni operazione)
        //    NON da loadedMapRef.current, che potrebbe essere stale
        const currentTerminals = workspaceTerminalsRef.current;
        const newTerminals = currentTerminals.filter((t) => t.id !== terminalId);
        const newLayout = computeLayout(newTerminals.length);

        // Aggiorna il ref sincrono IMMEDIATAMENTE (prima di await)
        workspaceTerminalsRef.current = newTerminals;

        // 4. Aggiorna backend
        const currentWs = loadedMapRef.current.get(workspaceId);
        if (currentWs) {
          const updatedConfig = {
            id: workspaceId,
            name: currentWs.name,
            rootPath: currentWs.rootPath,
            layout: newLayout,
            terminals: newTerminals,
            createdAt: currentWs.createdAt,
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
      })
      .catch((err) => {
        console.error("Close queue error:", err);
      });
  }, [activeWorkspaceId]);

  const handleActivateTerminal = useCallback((id: string) => {
    useTerminalStore.getState().setActiveTerminal(id);
  }, []);

  // La shortcut deve mostrare la conferma dentro al pane attivo, non chiudere
  // direttamente il terminale saltando il flusso visuale del TerminalPane.
  const closeRequestTokenRef = useRef(0);
  const requestCloseTerminalRef = useRef(() => {
    const activeId = useTerminalStore.getState().activeTerminalId;
    if (!activeId) return;
    setCloseRequest({
      terminalId: activeId,
      token: ++closeRequestTokenRef.current,
    });
  });
  useEffect(() => {
    (window as any).__traflix_request_close_terminal = () =>
      requestCloseTerminalRef.current();
    return () => {
      delete (window as any).__traflix_request_close_terminal;
    };
  }, []);

  // Aggiunge un nuovo terminale al workspace corrente.
  // Usa la stessa coda di closeQueueRef per evitare race con le chiusure.
  const handleAddTerminal = useCallback(() => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;

    closeQueueRef.current = closeQueueRef.current
      .then(async () => {
        // Guard: se il workspace non è più attivo, ignora
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

        const currentWs = loadedMapRef.current.get(workspaceId);
        if (!currentWs) return;

        // Limite massimo 8 terminali per workspace
        const currentTerminals = workspaceTerminalsRef.current;
        if (currentTerminals.length >= MAX_TERMINALS_PER_WORKSPACE) {
          addToastRef.current({
            type: "info",
            message: `Limite di ${MAX_TERMINALS_PER_WORKSPACE} terminali raggiunto in questo workspace.`,
          });
          return;
        }

        const newId = crypto.randomUUID();
        const newTerminal: TerminalConfig = {
          id: newId,
          shell: "powershell.exe",
          agentId: null,
          command: null,
          cwd: currentWs.rootPath,
          title: "Terminale",
        };

        // 1. Spawn backend
        try {
          await invokeWithTimeout(
            () =>
              invoke("terminal_spawn", {
                terminalId: newId,
                shell: newTerminal.shell,
                cwd: newTerminal.cwd,
                cols: 80,
                rows: 24,
              }),
            10000,
          );
        } catch (err) {
          console.error("Errore spawn terminale:", err);
          return;
        }

        // 2. Registra nel terminal store
        useTerminalStore.getState().addTerminal({
          id: newId,
          workspaceId,
          shell: newTerminal.shell,
          cwd: newTerminal.cwd,
          title: newTerminal.title,
          agent: null,
        });

        // 3. Aggiungi alla lista e ricalcola layout (ref sincrono)
        const newTerminals = [...currentTerminals, newTerminal];
        const newLayout = computeLayout(newTerminals.length);
        workspaceTerminalsRef.current = newTerminals;

        // 4. Aggiorna backend
        try {
          await invokeWithTimeout(
            () =>
              invoke("update_workspace", {
                id: workspaceId,
                config: {
                  id: workspaceId,
                  name: currentWs.name,
                  rootPath: currentWs.rootPath,
                  layout: newLayout,
                  terminals: newTerminals,
                  createdAt: currentWs.createdAt,
                  updatedAt: new Date().toISOString(),
                },
              }),
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

        // 6. Aggiorna workspace store + attiva il nuovo terminale
        useWorkspaceStore.getState().updateWorkspace(workspaceId, {
          terminalCount: newTerminals.length,
        });
        useTerminalStore.getState().setActiveTerminal(newId);
      })
      .catch((err) => {
        console.error("Add queue error:", err);
      });
  }, [activeWorkspaceId]);

  // Esponi handleAddTerminal globalmente per la shortcut Shift+Alt+D
  const addTerminalRef = useRef(handleAddTerminal);
  addTerminalRef.current = handleAddTerminal;
  useEffect(() => {
    (window as any).__traflix_add_terminal = () => {
      addTerminalRef.current();
    };
    return () => {
      delete (window as any).__traflix_add_terminal;
    };
  }, []);

  // Carica workspace attivo se non già in cache.
  // NON clear focus: WorkspaceGrid usa localFocusId per filtrare
  // il focus sul solo workspace attivo. Così se esci da una
  // workspace in focus mode e ci torni, il focus è preservato.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (!loadedMapRef.current.has(activeWorkspaceId)) {
      loadWorkspace(activeWorkspaceId);
    }
  }, [activeWorkspaceId, loadWorkspace]);

  // Pulisci i workspace rimossi dalla mappa — osserva tutto l'array workspaces
  useEffect(() => {
    const allIds = new Set(workspaces.map((w) => w.id));
    const toRemove = Array.from(loadedMapRef.current.keys()).filter(
      (key) => !allIds.has(key),
    );
    if (toRemove.length === 0) return;

    const terminalStore = useTerminalStore.getState();
    for (const key of toRemove) {
      terminalStore.killWorkspaceTerminals(key);
    }

    setLoadedMap((prev) => {
      const next = new Map(prev);
      for (const key of toRemove) next.delete(key);
      return next;
    });
  }, [workspaces]);

  // Sincronizza il ref workspaceTerminalsRef quando loadedMap cambia
  useEffect(() => {
    if (activeWorkspaceId) {
      const loaded = loadedMap.get(activeWorkspaceId);
      if (loaded) {
        workspaceTerminalsRef.current = loaded.terminals;
      }
    }
  }, [loadedMap, activeWorkspaceId]);

  // Empty state — nessun workspace aperto
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex h-full items-center justify-center px-8 text-neutral-text-muted">
          <div className="panel flex max-w-xl flex-col items-center px-12 py-14 text-center shadow-2xl tab-slide-in">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/25 transition-transform duration-200 hover:scale-105">
              <TerminalSquare size={32} strokeWidth={1.5} className="text-primary" />
            </div>
            <div>
            <h2 className="font-display font-extrabold text-2xl text-neutral-text mb-3 tracking-tight">
              Nessun Spazio Aperto
            </h2>
            <p className="text-[0.9375rem] text-neutral-text-dim max-w-md mb-8 leading-relaxed mx-auto">
              Seleziona un workspace dalla sidebar o creane uno nuovo per iniziare ad operare con i terminali ed agenti.
            </p>
            <button
               onClick={() => setWizardOpen(true)}
               className="inline-flex items-center gap-3 text-base font-extrabold rounded-2xl transition-all duration-300 hover:-translate-y-0.5 hover:scale-[1.02] active:scale-[0.97] hover:shadow-[0_0_24px_rgba(255,157,36,0.35)] cursor-pointer"
               style={{
                 padding: "14px 32px",
                 background: "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
                 color: "var(--color-neutral-bg)",
                 boxShadow: "0 6px 18px rgba(255, 157, 36, 0.22)",
               }}
             >
               <Plus size={20} strokeWidth={2.5} />
               Nuovo Spazio
             </button>
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
        <div
          className="bg-black/5 backdrop-blur-sm"
          style={{
            padding: "16px 24px 14px",
            flexShrink: 0,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "16px",
            borderBottom: "1px solid var(--color-neutral-border)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: "18px",
                color: "var(--color-neutral-text)",
                letterSpacing: "-0.02em",
                lineHeight: 1.25,
              }}
            >
              {activeLoaded.name}
            </h1>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--color-neutral-text-muted)",
                marginTop: "4px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.4,
              }}
            >
              {activeLoaded.rootPath}
            </p>
          </div>

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
              rows={activeLayout?.rows ?? 1}
              cols={activeLayout?.cols ?? 1}
              terminals={activeLoaded.terminals}
              closeRequest={closeRequest}
              onActivate={handleActivateTerminal}
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
