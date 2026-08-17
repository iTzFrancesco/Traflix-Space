import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../lib/timeout";

let backendSyncInFlight: Promise<void> | null = null;

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  layout: { rows: number; cols: number };
  terminalCount: number;
  agentCount: number;
  lastOpened: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  backendReady: boolean;
  backendSyncError: string | null;

  addWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  reorderWorkspaces: (ids: string[]) => void;
  activeWorkspace: () => Workspace | undefined;
  syncWithBackend: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,
      backendReady: false,
      backendSyncError: null,

      addWorkspace: (workspace) =>
        set((state) => ({
          workspaces: [...state.workspaces, workspace],
          activeWorkspaceId: workspace.id,
        })),

      removeWorkspace: (id) =>
        set((state) => {
          const filtered = state.workspaces.filter((w) => w.id !== id);
          return {
            workspaces: filtered,
            activeWorkspaceId:
              state.activeWorkspaceId === id
                ? filtered[0]?.id || null
                : state.activeWorkspaceId,
          };
        }),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      updateWorkspace: (id, updates) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === id ? { ...w, ...updates } : w,
          ),
        })),

      reorderWorkspaces: (ids) =>
        set((state) => ({
          workspaces: ids
            .map((id) => state.workspaces.find((w) => w.id === id)!)
            .filter(Boolean),
        })),

      activeWorkspace: () => {
        const { workspaces, activeWorkspaceId } = get();
        return workspaces.find((w) => w.id === activeWorkspaceId);
      },

      syncWithBackend: () => {
        if (backendSyncInFlight) return backendSyncInFlight;

        set({ backendReady: false, backendSyncError: null });
        backendSyncInFlight = (async () => {
          try {
            const backendWorkspaces = await invokeWithTimeout(
              () => invoke<
                Array<{
                  id: string;
                  name: string;
                  rootPath: string;
                  layout: { rows: number; cols: number };
                  terminals: Array<{ agentId: string | null }>;
                  createdAt: string;
                  updatedAt: string;
                }>
              >("get_workspaces"),
              10000,
            );

            set((state) => {
              const localById = new Map(
                state.workspaces.map((workspace) => [workspace.id, workspace]),
              );
              const nextWorkspaces = backendWorkspaces.map((backend) => {
                const local = localById.get(backend.id);
                return {
                  ...local,
                  id: backend.id,
                  name: backend.name,
                  rootPath: backend.rootPath,
                  layout: backend.layout,
                  terminalCount: backend.terminals.length,
                  agentCount: backend.terminals.filter((terminal) => terminal.agentId).length,
                  lastOpened: backend.updatedAt,
                  createdAt: backend.createdAt,
                  updatedAt: backend.updatedAt,
                };
              });
              const activeStillExists =
                state.activeWorkspaceId &&
                nextWorkspaces.some((workspace) => workspace.id === state.activeWorkspaceId);

              return {
                workspaces: nextWorkspaces,
                activeWorkspaceId: activeStillExists
                  ? state.activeWorkspaceId
                  : nextWorkspaces[0]?.id || null,
                backendReady: true,
                backendSyncError: null,
              };
            });
          } catch (err) {
            const message =
              err instanceof Error && err.message
                ? err.message
                : typeof err === "string"
                  ? err
                  : "Impossibile sincronizzare le workspace";
            console.error("Errore sincronizzazione backend:", err);
            set({ backendReady: false, backendSyncError: message });
          } finally {
            backendSyncInFlight = null;
          }
        })();

        return backendSyncInFlight;
      },
    }),
    {
      name: "traflix-workspaces",
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
      }),
    },
  ),
);
