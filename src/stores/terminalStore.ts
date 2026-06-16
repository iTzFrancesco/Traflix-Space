import { create } from "zustand";

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
  terminals: Map<string, TerminalState>;
  activeTerminalId: string | null;

  addTerminal: (config: { id: string; workspaceId: string; shell: string; cwd: string; title: string; agent: string | null }) => void;
  removeTerminal: (id: string) => void;
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (id: string) => void;
  markExited: (id: string, exitCode: number) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,

  addTerminal: (config) =>
    set((state) => {
      const next = new Map(state.terminals);
      if (!next.has(config.id)) {
        next.set(config.id, {
          id: config.id,
          workspaceId: config.workspaceId,
          title: config.title,
          shell: config.shell,
          cwd: config.cwd,
          agent: config.agent,
          isActive: false,
          spawned: false,
          exitCode: null,
        });
      }
      return { terminals: next };
    }),

  removeTerminal: (id) =>
    set((state) => {
      const next = new Map(state.terminals);
      next.delete(id);
      return {
        terminals: next,
        activeTerminalId: state.activeTerminalId === id ? null : state.activeTerminalId,
      };
    }),

  killWorkspaceTerminals: (workspaceId) =>
    set((state) => {
      const next = new Map(state.terminals);
      let activeCleared = false;
      for (const [id, t] of next) {
        if (t.workspaceId === workspaceId) {
          next.delete(id);
          if (state.activeTerminalId === id) activeCleared = true;
        }
      }
      return {
        terminals: next,
        activeTerminalId: activeCleared ? null : state.activeTerminalId,
      };
    }),

  setActiveTerminal: (id) =>
    set((state) => {
      if (state.activeTerminalId === id) return {};
      const next = new Map(state.terminals);
      if (state.activeTerminalId) {
        const prev = next.get(state.activeTerminalId);
        if (prev) next.set(state.activeTerminalId, { ...prev, isActive: false });
      }
      const terminal = next.get(id);
      if (terminal) next.set(id, { ...terminal, isActive: true });
      return { terminals: next, activeTerminalId: id };
    }),

  updateTitle: (id, title) =>
    set((state) => {
      const next = new Map(state.terminals);
      const t = next.get(id);
      if (t) next.set(id, { ...t, title });
      return { terminals: next };
    }),

  markSpawned: (id) =>
    set((state) => {
      const next = new Map(state.terminals);
      const t = next.get(id);
      if (t) next.set(id, { ...t, spawned: true });
      return { terminals: next };
    }),

  markExited: (id, exitCode) =>
    set((state) => {
      const next = new Map(state.terminals);
      const t = next.get(id);
      if (t) next.set(id, { ...t, exitCode, spawned: false });
      return { terminals: next };
    }),

  getByWorkspace: (workspaceId) => {
    const { terminals } = get();
    return Array.from(terminals.values()).filter((t) => t.workspaceId === workspaceId);
  },
}));
