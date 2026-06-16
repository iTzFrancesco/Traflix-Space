import { create } from "zustand";

export interface TerminalState {
  id: string;
  workspaceId: string;
  ptyId: string | null;
  title: string;
  process: string;
  agent: string | null;
  isActive: boolean;
  shell: string;
  cwd: string;
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

  createTerminal: (config: Omit<TerminalState, "id" | "ptyId" | "isActive"> & { id?: string }) => string;
  killTerminal: (id: string) => void;
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTerminalTitle: (id: string, title: string) => void;
  setTerminalPtyId: (id: string, ptyId: string) => void;
  getTerminalsByWorkspace: (workspaceId: string) => TerminalState[];
  getAgentCount: () => number;
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,

  createTerminal: (config) => {
    const id = config.id || crypto.randomUUID();
    set((state) => {
      const newConfig = { ...config };
      delete newConfig.id;
      return {
        terminals: new Map(state.terminals).set(id, {
          ...newConfig,
          id,
          ptyId: null,
          isActive: false,
        }),
      };
    });
    return id;
  },

  killTerminal: (id) =>
    set((state) => {
      const next = new Map(state.terminals);
      next.delete(id);
      return {
        terminals: next,
        activeTerminalId:
          state.activeTerminalId === id ? null : state.activeTerminalId,
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
      const prev = state.activeTerminalId;
      if (prev === id) return {};
      const next = new Map(state.terminals);
      if (prev) {
        const prevTerminal = next.get(prev);
        if (prevTerminal) next.set(prev, { ...prevTerminal, isActive: false });
      }
      const nextTerminal = next.get(id);
      if (nextTerminal) next.set(id, { ...nextTerminal, isActive: true });
      return { terminals: next, activeTerminalId: id };
    }),

  updateTerminalTitle: (id, title) =>
    set((state) => {
      const next = new Map(state.terminals);
      const terminal = next.get(id);
      if (terminal) {
        next.set(id, { ...terminal, title });
      }
      return { terminals: next };
    }),

  setTerminalPtyId: (id, ptyId) =>
    set((state) => {
      const next = new Map(state.terminals);
      const terminal = next.get(id);
      if (terminal) {
        next.set(id, { ...terminal, ptyId });
      }
      return { terminals: next };
    }),

  getTerminalsByWorkspace: (workspaceId) => {
    const { terminals } = get();
    return Array.from(terminals.values()).filter(
      (t) => t.workspaceId === workspaceId
    );
  },

  getAgentCount: () => {
    let count = 0;
    const { terminals } = get();
    terminals.forEach((t) => {
      if (t.agent && t.ptyId) count++;
    });
    return count;
  },
}));
