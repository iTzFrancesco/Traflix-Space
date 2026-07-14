import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";

export interface TerminalState {
  id: string;
  workspaceId: string;
  title: string;
  shell: string;
  cwd: string;
  agent: string | null;
  isActive: boolean;
  spawned: boolean;
  exitCode: number | null;
  agentLaunched: boolean;
}

export interface TerminalConfig {
  id: string;
  shell: string;
  agentId: string | null;
  command: string | null;
  cwd: string;
  title: string;
}

interface TerminalStore {
  terminals: Record<string, TerminalState>;
  activeTerminalId: string | null;

  addTerminal: (config: { id: string; workspaceId: string; shell: string; cwd: string; title: string; agent: string | null }) => void;
  removeTerminal: (id: string) => void;
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (id: string) => void;
  markExited: (id: string, exitCode: number) => void;
  markAgentLaunched: (id: string) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  terminals: {},
  activeTerminalId: null,

  addTerminal: (config) =>
    set((state) => {
      if (state.terminals[config.id]) return state;
      return {
        terminals: {
          ...state.terminals,
          [config.id]: {
            id: config.id,
            workspaceId: config.workspaceId,
            title: config.title,
            shell: config.shell,
            cwd: config.cwd,
            agent: config.agent,
            isActive: false,
            spawned: false,
            exitCode: null,
            agentLaunched: false,
          },
        },
      };
    }),

  removeTerminal: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.terminals;
      return {
        terminals: rest,
        activeTerminalId: state.activeTerminalId === id ? null : state.activeTerminalId,
      };
    }),

  killWorkspaceTerminals: (workspaceId) =>
    set((state) => {
      const next: Record<string, TerminalState> = {};
      let activeCleared = false;
      for (const [id, t] of Object.entries(state.terminals)) {
        if (t.workspaceId === workspaceId) {
          if (state.activeTerminalId === id) activeCleared = true;
          continue;
        }
        next[id] = t;
      }
      return {
        terminals: next,
        activeTerminalId: activeCleared ? null : state.activeTerminalId,
      };
    }),

  setActiveTerminal: (id) =>
    set((state) => {
      if (state.activeTerminalId === id) return state;
      const next: Record<string, TerminalState> = {};
      for (const [tid, t] of Object.entries(state.terminals)) {
        next[tid] = { ...t, isActive: tid === id };
      }
      return { terminals: next, activeTerminalId: id };
    }),

  updateTitle: (id, title) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.title === title) return state;
      return {
        terminals: { ...state.terminals, [id]: { ...t, title } },
      };
    }),

  markSpawned: (id) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.spawned) return state;
      return {
        terminals: { ...state.terminals, [id]: { ...t, spawned: true } },
      };
    }),

  markExited: (id, exitCode) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t) return state;
      return {
        terminals: { ...state.terminals, [id]: { ...t, exitCode, spawned: false } },
      };
    }),

  markAgentLaunched: (id) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.agentLaunched) return state;
      return {
        terminals: { ...state.terminals, [id]: { ...t, agentLaunched: true } },
      };
    }),

  getByWorkspace: (workspaceId) => {
    const { terminals } = get();
    return Object.values(terminals).filter((t) => t.workspaceId === workspaceId);
  },
}));

// Hook helper con shallow comparison per evitare re-render
export function useTerminalsByWorkspace(workspaceId: string) {
  return useStoreWithEqualityFn(
    useTerminalStore,
    (s) => Object.values(s.terminals).filter((t) => t.workspaceId === workspaceId),
    shallow,
  );
}
