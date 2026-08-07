import { useEffect, useState, useRef, useCallback } from "react";
import { TerminalSquare, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { useUIStore } from "../../stores/uiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore } from "../../stores/skillStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { computeLayout } from "../../lib/presets";
import { swapItemsById } from "../../lib/terminalOrdering";
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

interface AgentOpenedEvent {
  workspaceId: string;
  terminal: TerminalConfig;
}

interface AgentClosedEvent {
  workspaceId: string;
  terminalId: string;
  generation: number;
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
  // Ref sincrono della lista terminali (aggiornato subito, non dopo re-render).
  // The workspace id prevents a fast workspace switch from reusing the old
  // workspace's order for a reorder/add/close operation.
  const workspaceTerminalsRef = useRef<{
    workspaceId: string | null;
    terminals: TerminalConfig[];
  }>({ workspaceId: null, terminals: [] });

  // Jarvis opens/closes through the backend so the same visible PTY can be
  // registered in the frontend without a second spawn or hidden process.
  useEffect(() => {
    let disposed = false;
    const listeners = Promise.all([
      listen<AgentOpenedEvent>("jarvis-agent-opened", (event) => {
        if (disposed) return;
        const { workspaceId, terminal } = event.payload;
        const loaded = loadedMapRef.current.get(workspaceId);
        if (!loaded) return;

        // The backend owns the Jarvis open/restart flow: it has already
        // spawned the visible PTY and launched the provider CLI before this
        // event is useful to TerminalPane. Mark both facts authoritatively so
        // the normal frontend agentLaunchQueue never launches the same CLI a
        // second time when the new pane mounts.
        const terminalStore = useTerminalStore.getState();
        if (!terminalStore.terminals[terminal.id]) {
          terminalStore.addTerminal({
            id: terminal.id,
            workspaceId,
            shell: terminal.shell,
            cwd: terminal.cwd,
            title: terminal.title,
            agent: terminal.agentId,
          });
        }
        terminalStore.markSpawned(terminal.id);
        terminalStore.markAgentLaunched(terminal.id);

        // React state may not have committed a previous Jarvis-open event yet.
        // For the focused workspace, the synchronous terminal ref is the
        // authoritative event-to-event list so two rapid opens never drop the
        // first pane from the visible grid.
        const currentTerminals =
          workspaceTerminalsRef.current.workspaceId === workspaceId
            ? workspaceTerminalsRef.current.terminals
            : loaded.terminals;

        // A restart reuses the existing configured pane. In that case only
        // refresh its runtime flags above; never duplicate the workspace item.
        if (currentTerminals.some((item) => item.id === terminal.id)) {
          if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
            terminalStore.setActiveTerminal(terminal.id);
          }
          return;
        }

        const nextTerminals = [...currentTerminals, terminal];
        const nextLayout = computeLayout(nextTerminals.length);
        if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
          workspaceTerminalsRef.current = { workspaceId, terminals: nextTerminals };
        }
        setLoadedMap((previous) => {
          const current = previous.get(workspaceId);
          if (!current || current.terminals.some((item) => item.id === terminal.id)) return previous;
          const next = new Map(previous);
          next.set(workspaceId, { ...current, terminals: nextTerminals, layout: nextLayout });
          return next;
        });
        useWorkspaceStore.getState().updateWorkspace(workspaceId, {
          terminalCount: nextTerminals.length,
          agentCount: nextTerminals.filter((item) => item.agentId).length,
        });
        if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
          terminalStore.setActiveTerminal(terminal.id);
        }
      }),
      listen<AgentClosedEvent>("jarvis-agent-closed", (event) => {
        if (disposed) return;
        const { workspaceId, terminalId } = event.payload;
        useSkillStore.getState().clearPendingDrop(terminalId);
        useTerminalStore.getState().removeTerminal(terminalId);
        const loaded = loadedMapRef.current.get(workspaceId);
        if (!loaded) return;
        const currentTerminals =
          workspaceTerminalsRef.current.workspaceId === workspaceId
            ? workspaceTerminalsRef.current.terminals
            : loaded.terminals;
        const nextTerminals = currentTerminals.filter((item) => item.id !== terminalId);
        if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
          workspaceTerminalsRef.current = { workspaceId, terminals: nextTerminals };
        }
        setLoadedMap((previous) => {
          const current = previous.get(workspaceId);
          if (!current) return previous;
          const next = new Map(previous);
          next.set(workspaceId, { ...current, terminals: nextTerminals, layout: computeLayout(nextTerminals.length) });
          return next;
        });
        useWorkspaceStore.getState().updateWorkspace(workspaceId, {
          terminalCount: nextTerminals.length,
          agentCount: nextTerminals.filter((item) => item.agentId).length,
        });
      }),
    ]);
    return () => {
      disposed = true;
      void listeners.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten())).catch(() => undefined);
    };
  }, []);

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

        // A late load may populate the cache, but it must never steal the
        // active terminal from a workspace the user switched to meanwhile.
        if (
          firstId &&
          useWorkspaceStore.getState().activeWorkspaceId === id
        ) {
          terminalStore.setActiveTerminal(firstId);
        }

        // This is only an LRU cache for workspace configuration. Evicting a
        // cached config must never kill the user's live PTY or agent session;
        // TerminalPane can rehydrate the same backend PTY when the workspace
        // is visited again.
        const newOrder = openOrderRef.current
          .filter((k) => k !== id)
          .concat(id);

        const currentActive = useWorkspaceStore.getState().activeWorkspaceId;
        const toEvict = loadedMapRef.current.size >= MAX_OPEN_WORKSPACES
          ? newOrder.find(
              (k) => k !== currentActive && loadedMapRef.current.has(k),
            )
          : undefined;

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

        const currentWs = loadedMapRef.current.get(workspaceId);
        if (!currentWs) return;

        // 3. Leggi dal ref sincrono (aggiornato dopo ogni operazione), usando
        // la configurazione corrente come fallback dopo un cambio workspace.
        const currentTerminals =
          workspaceTerminalsRef.current.workspaceId === workspaceId
            ? workspaceTerminalsRef.current.terminals
            : currentWs.terminals;
        const newTerminals = currentTerminals.filter((t) => t.id !== terminalId);
        const newLayout = computeLayout(newTerminals.length);

        // Aggiorna il ref sincrono IMMEDIATAMENTE (prima di await)
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };

        // 4. Aggiorna backend
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
    useTerminalStore.getState().clearAgentAttention(id);
    useTerminalStore.getState().setActiveTerminal(id);
  }, []);

  const handleReorderTerminals = useCallback(
    (draggedId: string, targetId: string) => {
      const workspaceId = activeWorkspaceId;
      if (!workspaceId) return;

      if (draggedId === targetId) return;

      closeQueueRef.current = closeQueueRef.current
        .then(async () => {
          if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

          const currentWs = loadedMapRef.current.get(workspaceId);
          if (!currentWs) return;

          const currentTerminals =
            workspaceTerminalsRef.current.workspaceId === workspaceId
              ? workspaceTerminalsRef.current.terminals
              : currentWs.terminals;
          const newTerminals = swapItemsById(currentTerminals, draggedId, targetId);
          if (newTerminals === currentTerminals) return;

          workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };

          const updatedConfig = {
            id: workspaceId,
            name: currentWs.name,
            rootPath: currentWs.rootPath,
            layout: currentWs.layout,
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
            console.error("Errore aggiornamento workspace dopo riordino:", err);
          }

          setLoadedMap((prev) => {
            const next = new Map(prev);
            const existing = next.get(workspaceId);
            if (existing) {
              next.set(workspaceId, {
                ...existing,
                terminals: newTerminals,
              });
            }
            return new Map(next);
          });
        })
        .catch((err) => {
          console.error("Reorder queue error:", err);
        });
    },
    [activeWorkspaceId],
  );

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
        const currentTerminals =
          workspaceTerminalsRef.current.workspaceId === workspaceId
            ? workspaceTerminalsRef.current.terminals
            : currentWs.terminals;
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
                workspaceId,
                agentId: newTerminal.agentId,
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
        // The PTY was spawned before React mounted TerminalPane. Mark it as
        // live so the first pane mount rehydrates the prompt/state instead of
        // assuming it is a brand-new stream whose initial output was missed.
        useTerminalStore.getState().markSpawned(newId);

        // 3. Aggiungi alla lista e ricalcola layout (ref sincrono)
        const newTerminals = [...currentTerminals, newTerminal];
        const newLayout = computeLayout(newTerminals.length);
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };

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
        workspaceTerminalsRef.current = {
          workspaceId: activeWorkspaceId,
          terminals: loaded.terminals,
        };
      }
    }
  }, [loadedMap, activeWorkspaceId]);

  // Empty state — keep the desktop shell quiet and task-focused.
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex h-full items-center justify-center bg-neutral-darkest px-8">
          <div className="max-w-sm text-center tab-slide-in">
            <TerminalSquare size={24} strokeWidth={1.4} className="mx-auto text-neutral-text-muted" />
            <h2 className="mt-4 font-display text-base font-semibold tracking-[-0.02em] text-neutral-text">
              No workspace open
            </h2>
            <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-neutral-text-muted">
              Select a workspace from the sidebar or create one to start working.
            </p>
            <button type="button" onClick={() => setWizardOpen(true)} className="primary-button mt-5">
              <Plus size={14} /> New space
            </button>
          </div>
        </div>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
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
        {/* Compact workspace identity bar. Terminal content gets the space. */}
        <div className="flex h-12 shrink-0 items-center border-b border-neutral-border bg-neutral-surface px-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[13px] font-semibold tracking-[-0.02em] text-neutral-text">
              {activeLoaded.name}
            </h1>
            <p className="mt-0.5 truncate font-mono text-[9px] text-neutral-text-muted" title={activeLoaded.rootPath}>
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
              onReorderTerminals={handleReorderTerminals}
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
