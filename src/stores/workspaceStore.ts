import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../lib/timeout";

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

      syncWithBackend: async () => {
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

          const { workspaces: localWorkspaces } = get();

          const backendIds = new Set(backendWorkspaces.map((w) => w.id));
          const localIds = new Set(localWorkspaces.map((w) => w.id));

          // Aggiungi workspace presenti nel backend ma non in localStorage
          const toAdd = backendWorkspaces
            .filter((bw) => !localIds.has(bw.id))
            .map((bw): Workspace => ({
              id: bw.id,
              name: bw.name,
              rootPath: bw.rootPath,
              layout: bw.layout,
              terminalCount: bw.terminals.length,
              agentCount: bw.terminals.filter((t) => t.agentId).length,
              lastOpened: bw.updatedAt,
              createdAt: bw.createdAt,
              updatedAt: bw.updatedAt,
            }));

          // Rimuovi workspace presenti in localStorage ma non nel backend
          const toRemove = localWorkspaces
            .filter((lw) => !backendIds.has(lw.id))
            .map((lw) => lw.id);

          if (toAdd.length > 0 || toRemove.length > 0) {
            set((state) => {
              const filtered = state.workspaces.filter(
                (w) => !toRemove.includes(w.id),
              );
              const nextWorkspaces = [...filtered, ...toAdd];
              const activeStillExists =
                state.activeWorkspaceId &&
                !toRemove.includes(state.activeWorkspaceId);
              return {
                workspaces: nextWorkspaces,
                activeWorkspaceId: activeStillExists
                  ? state.activeWorkspaceId
                  : nextWorkspaces[0]?.id || null,
              };
            });
          }
        } catch (err) {
          console.error("Errore sincronizzazione backend:", err);
        }
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
