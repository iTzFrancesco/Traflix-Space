import { useWorkspaceStore } from "../stores/workspaceStore";

export function useWorkspace() {
  const store = useWorkspaceStore();

  return {
    ...store,
    createWorkspace: () => {},
    deleteWorkspace: (id: string) => store.removeWorkspace(id),
  };
}
