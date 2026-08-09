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
import {
  acceptsWorkspaceRevision,
  terminalIdentityCollision,
} from "../../lib/workspaceTerminalProtocol";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
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

interface TerminalRuntimeIdentity {
  workspaceId: string;
  generation: number;
  processId: number | null;
  agentLaunchOwner: "backend" | null;
  agentLaunchState: "starting" | "ready" | "failed" | null;
}

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

function ipcErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

async function persistTerminalMutation(
  workspaceId: string,
  initial: LoadedWorkspace,
  mutate: (terminals: TerminalConfig[]) => TerminalConfig[],
): Promise<LoadedWorkspace> {
  let base = initial;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const terminals = mutate(base.terminals);
    const config: LoadedWorkspace = {
      ...base,
      layout: computeLayout(terminals.length),
      terminals,
      updatedAt: new Date().toISOString(),
    };
    try {
      return await invokeWithTimeout(
        () => invoke<LoadedWorkspace>("update_workspace", {
          id: workspaceId,
          config,
          expectedUpdatedAt: base.updatedAt,
        }),
        10000,
      );
    } catch (error) {
      if (
        attempt === 0 &&
        ipcErrorMessage(error).includes("workspace_revision_conflict")
      ) {
        base = await invokeWithTimeout(
          () => invoke<LoadedWorkspace>("get_workspace", { id: workspaceId }),
          15000,
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("workspace_revision_conflict");
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
        terminalStore.syncWorkspaceTerminalOrder(
          id,
          (fullConfig.terminals || []).map((terminal) => terminal.id),
        );

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

        // 1. Kill exactly the generation the user confirmed.
        const terminalRuntime = useTerminalStore.getState().terminals[terminalId];
        if (terminalRuntime && terminalRuntime.generation !== null) {
          try {
            await invokeWithTimeout(
              () => invoke("terminal_kill", {
                terminalId,
                workspaceId: terminalRuntime.workspaceId,
                generation: terminalRuntime.generation,
                processId: terminalRuntime.processId,
              }),
              5000,
            );
          } catch (error) {
            console.warn("Terminal kill rejected:", error);
            return;
          }
        }

        // 2. Rimuovi dal terminal store (+ clear focus se necessario)
        useSkillStore.getState().clearPendingDrop(terminalId);
        useTerminalStore.getState().removeTerminal(
          terminalId,
          terminalRuntime?.generation ?? undefined,
        );

        const currentWs = loadedMapRef.current.get(workspaceId);
        if (!currentWs) return;

        // 3. Leggi dal ref sincrono (aggiornato dopo ogni operazione), usando
        // la configurazione corrente come fallback dopo un cambio workspace.
        // 3/4. Persist with optimistic revision validation. On a concurrent
        // Jarvis open/reorder, reload once and reapply only this removal.
        let updatedConfig: LoadedWorkspace;
        try {
          updatedConfig = await persistTerminalMutation(
            workspaceId,
            currentWs,
            (terminals) => terminals.filter((terminal) => terminal.id !== terminalId),
          );
        } catch (err) {
          console.error("Errore aggiornamento workspace:", err);
          addToastRef.current({
            type: "error",
            message: "Il terminale è stato chiuso, ma la workspace non è stata aggiornata.",
          });
          return;
        }
        const newTerminals = updatedConfig.terminals;
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };

        // 5. Aggiorna loadedMap
        const nextMap = new Map(loadedMapRef.current);
        nextMap.set(workspaceId, updatedConfig);
        loadedMapRef.current = nextMap;
        setLoadedMap(nextMap);
        useTerminalStore.getState().syncWorkspaceTerminalOrder(
          workspaceId,
          newTerminals.map((terminal) => terminal.id),
        );

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

          let updatedConfig: LoadedWorkspace;
          try {
            updatedConfig = await persistTerminalMutation(
              workspaceId,
              currentWs,
              (terminals) => swapItemsById(terminals, draggedId, targetId),
            );
          } catch (err) {
            console.error("Errore aggiornamento workspace dopo riordino:", err);
            return;
          }
          workspaceTerminalsRef.current = {
            workspaceId,
            terminals: updatedConfig.terminals,
          };
          const nextMap = new Map(loadedMapRef.current);
          nextMap.set(workspaceId, updatedConfig);
          loadedMapRef.current = nextMap;
          setLoadedMap(nextMap);
          useTerminalStore.getState().syncWorkspaceTerminalOrder(
            workspaceId,
            updatedConfig.terminals.map((terminal) => terminal.id),
          );
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
        let runtime: TerminalRuntimeIdentity;
        try {
          runtime = await invokeWithTimeout(
            () =>
              invoke<TerminalRuntimeIdentity>("terminal_spawn", {
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
          if (runtime.workspaceId !== workspaceId) {
            throw new Error(
              `stale-terminal-workspace: expected ${workspaceId}, current ${runtime.workspaceId || "missing"}`,
            );
          }
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
        useTerminalStore.getState().markSpawned(
          newId,
          runtime.workspaceId,
          runtime.generation,
          runtime.processId,
        );

        // 3. Aggiungi alla lista e ricalcola layout (ref sincrono)
        // 3/4. Append with revision validation so a concurrent Jarvis open is
        // retained. If the fresh config is full, roll back this exact PTY.
        let updatedConfig: LoadedWorkspace;
        try {
          updatedConfig = await persistTerminalMutation(
            workspaceId,
            currentWs,
            (terminals) => {
              if (terminals.some((terminal) => terminal.id === newId)) return terminals;
              if (terminals.length >= MAX_TERMINALS_PER_WORKSPACE) {
                throw new Error("workspace_terminal_limit");
              }
              return [...terminals, newTerminal];
            },
          );
        } catch (err) {
          console.error("Errore aggiornamento workspace:", err);
          try {
            await invokeWithTimeout(
              () => invoke("terminal_kill", {
                terminalId: newId,
                workspaceId: runtime.workspaceId,
                generation: runtime.generation,
                processId: runtime.processId,
              }),
              5000,
            );
          } catch (rollbackError) {
            console.warn("New terminal rollback failed:", rollbackError);
          }
          useTerminalStore.getState().removeTerminal(newId, runtime.generation);
          return;
        }
        const newTerminals = updatedConfig.terminals;
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };

        // 5. Aggiorna loadedMap
        const nextMap = new Map(loadedMapRef.current);
        nextMap.set(workspaceId, updatedConfig);
        loadedMapRef.current = nextMap;
        setLoadedMap(nextMap);
        useTerminalStore.getState().syncWorkspaceTerminalOrder(
          workspaceId,
          newTerminals.map((terminal) => terminal.id),
        );

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

  // Carica workspace attivo se non già in cache. Watching loadedMap as well as
  // the active id lets the current workspace recover automatically if cache
  // churn removes its config while async loads are completing.
  // NON clear focus: WorkspaceGrid usa localFocusId per filtrare il focus sul
  // solo workspace attivo. Così se esci da una workspace in focus mode e ci
  // torni, il focus è preservato.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (
      !loadedMap.has(activeWorkspaceId) &&
      !loadingRef.current.has(activeWorkspaceId)
    ) {
      loadWorkspace(activeWorkspaceId);
    }
  }, [activeWorkspaceId, loadedMap, loadWorkspace]);

  // A cached workspace does not pass through loadWorkspace again. Reassert
  // the active terminal when returning to it so focus/resize state cannot
  // remain attached to a terminal from the previous workspace.
  useEffect(() => {
    if (!activeWorkspaceId || !activeLoaded) return;
    const firstActiveTerminalId = activeLoaded.terminals[0]?.id;
    if (!firstActiveTerminalId) return;

    const activeTerminalId = useTerminalStore.getState().activeTerminalId;
    if (
      !activeLoaded.terminals.some((terminal) => terminal.id === activeTerminalId)
    ) {
      useTerminalStore.getState().setActiveTerminal(firstActiveTerminalId);
    }
  }, [activeWorkspaceId, activeLoaded]);

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
