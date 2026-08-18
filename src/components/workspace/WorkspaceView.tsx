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
import {
  acceptsWorkspaceRevision,
  terminalIdentityCollision,
} from "../../lib/workspaceTerminalProtocol";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import { WorkspaceGrid } from "./WorkspaceGrid";
import { NewSpaceWizard } from "./NewSpaceWizard";
import { useWorkspaceTerminalActions } from "./useWorkspaceTerminalActions";
import type { LoadedWorkspace } from "./workspaceTypes";
import type { TerminalConfig } from "../../stores/terminalStore";

interface AgentOpenedEvent {
  workspaceId: string;
  terminal: TerminalConfig;
  generation: number;
  processId: number | null;
  launchState: "starting" | "ready" | "failed";
}

interface AgentClosedEvent {
  workspaceId: string;
  terminalId: string;
  generation: number;
  processId: number | null;
}

export function WorkspaceView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const backendReady = useWorkspaceStore((s) => s.backendReady);
  const backendSyncError = useWorkspaceStore((s) => s.backendSyncError);
  const syncWithBackend = useWorkspaceStore((s) => s.syncWithBackend);
  // Workspace metadata changes frequently while terminals stream. Subscribe
  // only to membership for the cache cleanup effect; the active workspace is
  // selected separately below.
  const workspaceIdsKey = useWorkspaceStore((state) =>
    state.workspaces.map((workspace) => workspace.id).join("|"),
  );
  const addToast = useToastStore((s) => s.addToast);
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);
  const wizardOpen = useUIStore((s) => s.wizardOpen);

  const MAX_OPEN_WORKSPACES = 8;

  const [loadedMap, setLoadedMap] = useState<Map<string, LoadedWorkspace>>(
    () => new Map(),
  );
  const [failedWorkspaceLoads, setFailedWorkspaceLoads] = useState<Set<string>>(
    () => new Set(),
  );
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

  const {
    closeRequest,
    handleActivateTerminal,
    handleCloseTerminal,
    handleReorderTerminals,
  } = useWorkspaceTerminalActions({
    activeWorkspaceId,
    loadedMapRef,
    setLoadedMap,
    workspaceTerminalsRef,
    closeQueueRef,
    addToast,
  });

  // Jarvis opens/closes through the backend so the same visible PTY can be
  // registered in the frontend without a second spawn or hidden process.
  useEffect(() => {
    let disposed = false;
    const refreshWorkspace = async (workspaceId: string) => {
      const fullConfig = await invokeWithTimeout(
        () => invoke<LoadedWorkspace>("get_workspace", { id: workspaceId }),
        15000,
      );
      if (disposed) return;
      const terminalStore = useTerminalStore.getState();
      const collision = terminalIdentityCollision(
        workspaceId,
        fullConfig.terminals.map((terminal) => terminal.id),
        terminalStore.terminals,
      );
      if (collision) {
        throw new Error(`terminal_id_workspace_collision:${collision}`);
      }
      const current = loadedMapRef.current.get(workspaceId);
      if (!acceptsWorkspaceRevision(current?.updatedAt, fullConfig.updatedAt)) {
        console.info("[workspace-lifecycle] stale refresh ignored", {
          workspaceId,
          currentUpdatedAt: current?.updatedAt,
          receivedUpdatedAt: fullConfig.updatedAt,
        });
        return;
      }
      for (const terminal of fullConfig.terminals) {
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
      }
      terminalStore.syncWorkspaceTerminalOrder(
        workspaceId,
        fullConfig.terminals.map((terminal) => terminal.id),
      );
      const nextMap = new Map(loadedMapRef.current);
      nextMap.set(workspaceId, {
        ...fullConfig,
        layout: computeLayout(fullConfig.terminals.length),
      });
      loadedMapRef.current = nextMap;
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        workspaceTerminalsRef.current = {
          workspaceId,
          terminals: fullConfig.terminals,
        };
      }
      setLoadedMap(nextMap);
      useWorkspaceStore.getState().updateWorkspace(workspaceId, {
        terminalCount: fullConfig.terminals.length,
        agentCount: fullConfig.terminals.filter((terminal) => terminal.agentId).length,
      });
    };
    const enqueueRefresh = (workspaceId: string) => {
      closeQueueRef.current = closeQueueRef.current
        .then(() => refreshWorkspace(workspaceId))
        .catch((error) => {
          console.error("Workspace event reconciliation failed:", error);
        });
    };
    const listeners = Promise.allSettled([
      listen<AgentOpenedEvent>("jarvis-agent-opened", (event) => {
        if (disposed) return;
        const { workspaceId, terminal, generation, processId, launchState } = event.payload;

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
        terminalStore.markBackendAgentLaunch(
          terminal.id,
          workspaceId,
          generation,
          processId,
          launchState,
        );
        const accepted = useTerminalStore.getState().terminals[terminal.id];
        if (
          accepted?.workspaceId === workspaceId &&
          accepted.generation === generation &&
          accepted.processId === processId &&
          useWorkspaceStore.getState().activeWorkspaceId === workspaceId
        ) {
          terminalStore.setActiveTerminal(terminal.id);
        }
        enqueueRefresh(workspaceId);
      }),
      listen<AgentClosedEvent>("jarvis-agent-closed", (event) => {
        if (disposed) return;
        const { workspaceId, terminalId, generation, processId } = event.payload;
        const current = useTerminalStore.getState().terminals[terminalId];
        if (
          current &&
          (current.workspaceId !== workspaceId ||
            current.generation !== generation ||
            current.processId !== processId)
        ) {
          console.warn("[terminal-lifecycle] stale Jarvis close ignored", {
            terminalId,
            workspaceId,
            generation,
            processId,
            currentGeneration: current.generation,
            currentProcessId: current.processId,
          });
          return;
        }
        useSkillStore.getState().clearPendingDrop(terminalId);
        useTerminalStore.getState().removeTerminal(terminalId, generation);
        enqueueRefresh(workspaceId);
      }),
    ]).then((results) => {
      const active: Array<() => void> = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          active.push(result.value);
        } else {
          reportFrontendDiagnostic("terminal-listener-error", result.reason, {
            state: "workspace-lifecycle",
          });
          console.error("Workspace lifecycle listener setup failed:", result.reason);
        }
      }
      return active;
    });
    return () => {
      disposed = true;
      void listeners
        .then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
        .catch((error) => console.error("Workspace listener cleanup failed:", error));
    };
  }, []);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const activeLoaded = activeWorkspaceId
    ? loadedMap.get(activeWorkspaceId)
    : undefined;
  const loadWorkspace = useCallback((id: string) => {
    if (loadedMapRef.current.has(id) || loadingRef.current.has(id)) return;
    loadingRef.current.add(id);
    setFailedWorkspaceLoads((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });

    invokeWithTimeout(
      () =>
        invoke<LoadedWorkspace>("get_workspace", { id }),
      15000,
    )
      .then((fullConfig) => {
        // Registra i terminali nel terminalStore
        const terminalStore = useTerminalStore.getState();
        const workspaceStillKnown = useWorkspaceStore
          .getState()
          .workspaces.some((candidate) => candidate.id === id);
        if (!workspaceStillKnown) {
          console.info("[workspace-lifecycle] load for removed workspace ignored", { id });
          return;
        }
        const collision = terminalIdentityCollision(
          id,
          (fullConfig.terminals || []).map((terminal) => terminal.id),
          terminalStore.terminals,
        );
        if (collision) {
          throw new Error(`terminal_id_workspace_collision:${collision}`);
        }
        const newerCached = loadedMapRef.current.get(id);
        if (!acceptsWorkspaceRevision(newerCached?.updatedAt, fullConfig.updatedAt)) {
          console.info("[workspace-lifecycle] stale async load ignored", {
            id,
            cachedUpdatedAt: newerCached?.updatedAt,
            receivedUpdatedAt: fullConfig.updatedAt,
          });
          return;
        }
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
        }
        const terminalIds = (fullConfig.terminals || []).map(
          (terminal) => terminal.id,
        );
        terminalStore.syncWorkspaceTerminalOrder(
          id,
          terminalIds,
        );

        // A late load may populate the cache, but it must never steal the
        // active terminal from a workspace the user switched to meanwhile.
        if (
          useWorkspaceStore.getState().activeWorkspaceId === id
        ) {
          terminalStore.restoreWorkspaceSelection(id, terminalIds);
        }

        // This is only an LRU cache for workspace configuration. Evicting a
        // cached config must never kill the user's live PTY or agent session;
        // TerminalPane can rehydrate the same backend PTY when the workspace
        // is visited again. The eviction target is resolved inside the state
        // updater so a workspace that becomes active during an async load is
        // never removed by a stale precomputed candidate.
        const newOrder = openOrderRef.current
          .filter((k) => k !== id)
          .concat(id);
        openOrderRef.current = newOrder;

        const next = new Map(loadedMapRef.current);
        next.set(id, {
          id: fullConfig.id,
          name: fullConfig.name,
          rootPath: fullConfig.rootPath,
          layout: fullConfig.layout,
          terminals: fullConfig.terminals || [],
          createdAt: fullConfig.createdAt,
          updatedAt: fullConfig.updatedAt,
        });

        if (next.size > MAX_OPEN_WORKSPACES) {
          const activeAtCommit = useWorkspaceStore.getState().activeWorkspaceId;
          const toEvict = newOrder.find(
            (key) => key !== activeAtCommit && key !== id && next.has(key),
          );
          if (toEvict) next.delete(toEvict);
        }
        loadedMapRef.current = next;
        setLoadedMap(next);
      })
      .catch((err) => {
        console.error("Errore caricamento workspace:", err);
        reportFrontendDiagnostic("workspace-load-error", err, {
          workspaceId: id,
          state: "load-workspace",
        });
        setFailedWorkspaceLoads((previous) => {
          if (previous.has(id)) return previous;
          return new Set(previous).add(id);
        });
        addToastRef.current({
          type: "error",
          message: "Errore caricamento workspace",
        });
      })
      .finally(() => {
        loadingRef.current.delete(id);
      });
  }, []);

  // Carica workspace attivo se non già in cache. Watching loadedMap as well as
  // the active id lets the current workspace recover automatically if cache
  // churn removes its config while async loads are completing.
  // NON clear focus: WorkspaceGrid usa localFocusId per filtrare il focus sul
  // solo workspace attivo. Così se esci da una workspace in focus mode e ci
  // torni, il focus è preservato.
  useEffect(() => {
    if (!backendReady || !activeWorkspaceId) return;
    if (
      !loadedMap.has(activeWorkspaceId) &&
      !loadingRef.current.has(activeWorkspaceId)
    ) {
      loadWorkspace(activeWorkspaceId);
    }
  }, [activeWorkspaceId, backendReady, loadedMap, loadWorkspace]);

  // A cached workspace does not pass through loadWorkspace again. Restore its
  // own active/focus identity instead of defaulting to the first pane or
  // retaining a pointer from the previously visible workspace.
  useEffect(() => {
    if (!backendReady || !activeWorkspaceId || !activeLoaded) return;
    useTerminalStore.getState().restoreWorkspaceSelection(
      activeWorkspaceId,
      activeLoaded.terminals.map((terminal) => terminal.id),
    );
    if (activeLoaded.terminals.length === 0) {
      invoke("terminal_set_active", {
        terminalId: "",
        workspaceId: null,
        generation: null,
        processId: null,
      }).catch((error) => {
        reportFrontendDiagnostic("terminal-lifecycle-error", error, {
          workspaceId: activeWorkspaceId,
          state: "clear-empty-workspace-active-terminal",
        });
      });
    }
  }, [activeWorkspaceId, activeLoaded, backendReady]);

  // Pulisci i workspace rimossi dalla mappa — osserva solo l'identità dei workspace
  useEffect(() => {
    const allIds = new Set(
      useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id),
    );
    const toRemove = Array.from(loadedMapRef.current.keys()).filter(
      (key) => !allIds.has(key),
    );
    if (toRemove.length === 0) return;

    const terminalStore = useTerminalStore.getState();
    for (const key of toRemove) {
      terminalStore.forgetWorkspaceTerminals(key);
    }

    setFailedWorkspaceLoads((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const key of toRemove) changed = next.delete(key) || changed;
      return changed ? next : previous;
    });

    setLoadedMap((prev) => {
      const next = new Map(prev);
      for (const key of toRemove) next.delete(key);
      return next;
    });
  }, [workspaceIdsKey]);

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

  if (!backendReady) {
    return (
      <>
        <div className="flex h-full items-center justify-center bg-neutral-darkest px-8">
          <div className="surface-card w-full max-w-sm px-6 py-5 text-center">
            <TerminalSquare
              size={22}
              strokeWidth={1.4}
              className="mx-auto text-neutral-text-muted"
            />
            <p
              className="mt-3 text-sm font-semibold text-neutral-text"
              role={backendSyncError ? "alert" : "status"}
            >
              {backendSyncError
                ? "Impossibile sincronizzare lo spazio di lavoro"
                : "Sincronizzazione spazio di lavoro…"}
            </p>
            {backendSyncError ? (
              <button
                type="button"
                className="primary-button mt-4"
                onClick={() => void syncWithBackend()}
              >
                Riprova
              </button>
            ) : null}
          </div>
        </div>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

  // Empty state — keep the desktop shell quiet and task-focused.
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex h-full items-center justify-center bg-neutral-darkest px-8">
          <div className="w-full max-w-sm text-center tab-slide-in">
            <div className="flex justify-center">
              <TerminalSquare size={24} strokeWidth={1.4} className="text-neutral-text-muted" />
            </div>
            <h2 className="mt-4 font-display text-base font-semibold tracking-[-0.02em] text-neutral-text">
              Nessuno spazio di lavoro aperto
            </h2>
            <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-neutral-text-muted">
              Seleziona uno spazio dalla barra laterale oppure creane uno per iniziare.
            </p>
            <button type="button" onClick={() => setWizardOpen(true)} className="primary-button mt-5">
              <Plus size={14} /> Nuovo spazio
            </button>
          </div>
        </div>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

  // Loading/recovery state — a failed IPC must never leave an inert blank view.
  if (!activeLoaded) {
    const loadFailed = activeWorkspaceId
      ? failedWorkspaceLoads.has(activeWorkspaceId)
      : false;
    return (
      <>
        <div className="flex h-full items-center justify-center bg-neutral-darkest px-8">
          <div className="surface-card w-full max-w-sm px-6 py-5 text-center">
            <TerminalSquare
              size={22}
              strokeWidth={1.4}
              className="mx-auto text-neutral-text-muted"
            />
            <p
              className="mt-3 text-sm font-semibold text-neutral-text"
              role={loadFailed ? "alert" : "status"}
            >
              {loadFailed
                ? "Impossibile caricare lo spazio di lavoro"
                : "Caricamento spazio di lavoro…"}
            </p>
            {loadFailed && activeWorkspaceId ? (
              <button
                type="button"
                className="primary-button mt-4"
                onClick={() => loadWorkspace(activeWorkspaceId)}
              >
                Riprova
              </button>
            ) : null}
          </div>
        </div>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

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
        {/* Workspace identity bar. The terminal grid gets the remaining space. */}
        <div
          className="shrink-0 border-b border-neutral-border bg-black/5 px-6 pb-3.5 pt-4 backdrop-blur-sm"
        >
          <div className="min-w-0">
            <h1 className="font-display text-lg font-extrabold leading-tight tracking-[-0.02em] text-neutral-text">
              {activeLoaded.name}
            </h1>
            <p className="mt-1 truncate font-mono text-[11px] leading-relaxed text-neutral-text-muted" title={activeLoaded.rootPath}>
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
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <WorkspaceGrid
              workspaceId={activeLoaded.id}
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
