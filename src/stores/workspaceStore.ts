import { create } from "zustand";
import { persist } from "zustand/middleware";

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
    }),
    {
      name: "traflix-workspaces",
    },
  ),
);
