import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore } from "../../stores/skillStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { computeLayout } from "../../lib/presets";
import { swapItemsById } from "../../lib/terminalOrdering";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import type { ToastType } from "../../stores/toastStore";
import type { TerminalConfig } from "../../stores/terminalStore";
import type { TerminalRuntimeIdentity } from "../terminal/types";
import type {
  LoadedWorkspace,
  TerminalCloseRequest,
  WorkspaceTerminalsRef,
} from "./workspaceTypes";

const MAX_TERMINALS_PER_WORKSPACE = 8;

type WorkspaceToast = {
  type: ToastType;
  message: string;
};

interface UseWorkspaceTerminalActionsOptions {
  activeWorkspaceId: string | null;
  loadedMapRef: MutableRefObject<Map<string, LoadedWorkspace>>;
  setLoadedMap: Dispatch<SetStateAction<Map<string, LoadedWorkspace>>>;
  workspaceTerminalsRef: MutableRefObject<WorkspaceTerminalsRef>;
  closeQueueRef: MutableRefObject<Promise<void>>;
  addToast: (toast: WorkspaceToast) => void;
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

export function useWorkspaceTerminalActions({
  activeWorkspaceId,
  loadedMapRef,
  setLoadedMap,
  workspaceTerminalsRef,
  closeQueueRef,
  addToast,
}: UseWorkspaceTerminalActionsOptions) {
  const [closeRequest, setCloseRequest] = useState<TerminalCloseRequest | null>(null);
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  const handleCloseTerminal = useCallback((terminalId: string) => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;

    closeQueueRef.current = closeQueueRef.current
      .then(async () => {
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;

        const terminalRuntime = useTerminalStore.getState().terminals[terminalId];
        if (
          !terminalRuntime ||
          terminalRuntime.workspaceId !== workspaceId ||
          terminalRuntime.generation === null
        ) {
          reportFrontendDiagnostic(
            "terminal-lifecycle-error",
            "terminal runtime identity unavailable during close",
            { terminalId, workspaceId, state: "close-before-runtime-ready" },
          );
          addToastRef.current({
            type: "info",
            message: "Il terminale è ancora in avvio: riprova la chiusura appena compare il prompt.",
          });
          return;
        }

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
          useTerminalStore.getState().markExited(
            terminalId,
            terminalRuntime.workspaceId,
            terminalRuntime.generation,
            terminalRuntime.processId,
            terminalRuntime.exitCode ?? 0,
          );
        } catch (error) {
          const current = useTerminalStore.getState().terminals[terminalId];
          const exactExitedRuntimeAlreadyAbsent =
            current?.workspaceId === terminalRuntime.workspaceId &&
            current.generation === terminalRuntime.generation &&
            current.processId === terminalRuntime.processId &&
            current.exitCode !== null &&
            ipcErrorMessage(error).includes(`Terminal ${terminalId} not found`);
          if (!exactExitedRuntimeAlreadyAbsent) {
            console.warn("Terminal kill rejected:", error);
            reportFrontendDiagnostic("terminal-kill-error", error, {
              terminalId,
              workspaceId: terminalRuntime.workspaceId,
              generation: terminalRuntime.generation,
              processId: terminalRuntime.processId,
              state: "close-request-rejected",
            });
            addToastRef.current({
              type: "error",
              message: "Chiusura non riuscita: il terminale è rimasto aperto e può essere riprovato.",
            });
            return;
          }
          console.info("[terminal-lifecycle] close retry found an already removed runtime", {
            terminalId,
            workspaceId: terminalRuntime.workspaceId,
            generation: terminalRuntime.generation,
            processId: terminalRuntime.processId,
          });
        }

        let updatedConfig: LoadedWorkspace;
        try {
          updatedConfig = await invokeWithTimeout(
            () => invoke<LoadedWorkspace>("terminal_commit_close", {
              terminalId,
              workspaceId: terminalRuntime.workspaceId,
              generation: terminalRuntime.generation,
              processId: terminalRuntime.processId,
            }),
            10000,
          );
        } catch (error) {
          console.error("Errore aggiornamento workspace:", error);
          reportFrontendDiagnostic("terminal-lifecycle-error", error, {
            terminalId,
            workspaceId,
            generation: terminalRuntime.generation,
            processId: terminalRuntime.processId,
            state: "close-config-commit",
          });
          addToastRef.current({
            type: "error",
            message: "Il terminale è stato chiuso, ma la workspace non è stata aggiornata.",
          });
          return;
        }

        const newTerminals = updatedConfig.terminals;
        useSkillStore.getState().clearPendingDrop(terminalId);
        useTerminalStore.getState().removeTerminal(terminalId, terminalRuntime.generation);
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };
        const nextMap = new Map(loadedMapRef.current);
        nextMap.set(workspaceId, updatedConfig);
        loadedMapRef.current = nextMap;
        setLoadedMap(nextMap);
        useTerminalStore.getState().syncWorkspaceTerminalOrder(
          workspaceId,
          newTerminals.map((terminal) => terminal.id),
        );
        useWorkspaceStore.getState().updateWorkspace(workspaceId, {
          terminalCount: newTerminals.length,
          agentCount: newTerminals.filter((terminal) => terminal.agentId).length,
        });
      })
      .catch((error) => console.error("Close queue error:", error));
  }, [activeWorkspaceId, closeQueueRef, loadedMapRef, setLoadedMap, workspaceTerminalsRef]);

  const handleActivateTerminal = useCallback((id: string) => {
    useTerminalStore.getState().clearAgentAttention(id);
    useTerminalStore.getState().setActiveTerminal(id);
  }, []);

  const handleReorderTerminals = useCallback((draggedId: string, targetId: string) => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId || draggedId === targetId) return;

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
        } catch (error) {
          console.error("Errore aggiornamento workspace dopo riordino:", error);
          return;
        }
        workspaceTerminalsRef.current = { workspaceId, terminals: updatedConfig.terminals };
        const nextMap = new Map(loadedMapRef.current);
        nextMap.set(workspaceId, updatedConfig);
        loadedMapRef.current = nextMap;
        setLoadedMap(nextMap);
        useTerminalStore.getState().syncWorkspaceTerminalOrder(
          workspaceId,
          updatedConfig.terminals.map((terminal) => terminal.id),
        );
      })
      .catch((error) => console.error("Reorder queue error:", error));
  }, [activeWorkspaceId, closeQueueRef, loadedMapRef, setLoadedMap, workspaceTerminalsRef]);

  const handleAddTerminal = useCallback(() => {
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;

    closeQueueRef.current = closeQueueRef.current
      .then(async () => {
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
        const currentWs = loadedMapRef.current.get(workspaceId);
        if (!currentWs) return;
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
        let runtime: TerminalRuntimeIdentity;
        try {
          runtime = await invokeWithTimeout(
            () => invoke<TerminalRuntimeIdentity>("terminal_spawn", {
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
            throw new Error(`stale-terminal-workspace: expected ${workspaceId}, current ${runtime.workspaceId || "missing"}`);
          }
        } catch (error) {
          console.error("Errore spawn terminale:", error);
          return;
        }

        useTerminalStore.getState().addTerminal({
          id: newId,
          workspaceId,
          shell: newTerminal.shell,
          cwd: newTerminal.cwd,
          title: newTerminal.title,
          agent: null,
        });
        useTerminalStore.getState().markSpawned(
          newId,
          runtime.workspaceId,
          runtime.generation,
          runtime.processId,
        );

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
        } catch (error) {
          console.error("Errore aggiornamento workspace:", error);
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
            useTerminalStore.getState().removeTerminal(newId, runtime.generation);
            return;
          } catch (rollbackError) {
            console.warn("New terminal rollback failed:", rollbackError);
            let reconciled = loadedMapRef.current.get(workspaceId) ?? currentWs;
            try {
              reconciled = await invokeWithTimeout(
                () => invoke<LoadedWorkspace>("get_workspace", { id: workspaceId }),
                10000,
              );
            } catch (reconcileError) {
              console.warn("Workspace reconciliation after add rollback failed:", reconcileError);
            }
            const retainedConfig = reconciled.terminals.some((terminal) => terminal.id === newId)
              ? reconciled
              : {
                  ...reconciled,
                  layout: computeLayout(reconciled.terminals.length + 1),
                  terminals: [...reconciled.terminals, newTerminal],
                };
            const nextMap = new Map(loadedMapRef.current);
            nextMap.set(workspaceId, retainedConfig);
            loadedMapRef.current = nextMap;
            workspaceTerminalsRef.current = { workspaceId, terminals: retainedConfig.terminals };
            setLoadedMap(nextMap);
            useTerminalStore.getState().syncWorkspaceTerminalOrder(
              workspaceId,
              retainedConfig.terminals.map((terminal) => terminal.id),
            );
            useWorkspaceStore.getState().updateWorkspace(workspaceId, {
              terminalCount: retainedConfig.terminals.length,
              agentCount: retainedConfig.terminals.filter((terminal) => terminal.agentId).length,
            });
            addToastRef.current({
              type: "error",
              message: "Il terminale è rimasto aperto: riprova la chiusura quando il backend risponde.",
            });
            return;
          }
        }

        const newTerminals = updatedConfig.terminals;
        workspaceTerminalsRef.current = { workspaceId, terminals: newTerminals };
        const nextMap = new Map(loadedMapRef.current);
        nextMap.set(workspaceId, updatedConfig);
        loadedMapRef.current = nextMap;
        setLoadedMap(nextMap);
        useTerminalStore.getState().syncWorkspaceTerminalOrder(
          workspaceId,
          newTerminals.map((terminal) => terminal.id),
        );
        useWorkspaceStore.getState().updateWorkspace(workspaceId, {
          terminalCount: newTerminals.length,
        });
        if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
          useTerminalStore.getState().setActiveTerminal(newId);
        }
      })
      .catch((error) => console.error("Add queue error:", error));
  }, [activeWorkspaceId, closeQueueRef, loadedMapRef, setLoadedMap, workspaceTerminalsRef]);

  const closeRequestTokenRef = useRef(0);
  const requestCloseTerminalRef = useRef(() => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const activeId = workspaceId
      ? useTerminalStore.getState().activeTerminalByWorkspace[workspaceId] ?? null
      : null;
    if (!activeId) return;
    setCloseRequest({ terminalId: activeId, token: ++closeRequestTokenRef.current });
  });

  useEffect(() => {
    (window as Window & { __traflix_request_close_terminal?: () => void }).__traflix_request_close_terminal = () =>
      requestCloseTerminalRef.current();
    return () => {
      delete (window as Window & { __traflix_request_close_terminal?: () => void }).__traflix_request_close_terminal;
    };
  }, []);

  const addTerminalRef = useRef(handleAddTerminal);
  addTerminalRef.current = handleAddTerminal;
  useEffect(() => {
    (window as Window & { __traflix_add_terminal?: () => void }).__traflix_add_terminal = () => {
      addTerminalRef.current();
    };
    return () => {
      delete (window as Window & { __traflix_add_terminal?: () => void }).__traflix_add_terminal;
    };
  }, []);

  return {
    closeRequest,
    handleActivateTerminal,
    handleCloseTerminal,
    handleReorderTerminals,
  };
}
