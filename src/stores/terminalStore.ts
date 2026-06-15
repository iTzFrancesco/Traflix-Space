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
  outputBuffer: string[];
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

  createTerminal: (config: Omit<TerminalState, "id" | "ptyId" | "outputBuffer" | "isActive">) => string;
  killTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTerminalTitle: (id: string, title: string) => void;
  setTerminalPtyId: (id: string, ptyId: string) => void;
  writeToTerminal: (id: string, data: string) => void;
  getTerminalsByWorkspace: (workspaceId: string) => TerminalState[];
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,

  createTerminal: (config) => {
    const id = crypto.randomUUID();
    set((state) => ({
      terminals: new Map(state.terminals).set(id, {
        ...config,
        id,
        ptyId: null,
        isActive: false,
        outputBuffer: [],
      }),
    }));
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

  setActiveTerminal: (id) =>
    set((state) => {
      const next = new Map(state.terminals);
      next.forEach((t, key) => {
        next.set(key, { ...t, isActive: key === id });
      });
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

  writeToTerminal: (id, data) =>
    set((state) => {
      const next = new Map(state.terminals);
      const terminal = next.get(id);
      if (terminal) {
        next.set(id, {
          ...terminal,
          outputBuffer: [...terminal.outputBuffer, data],
        });
      }
      return { terminals: next };
    }),

  getTerminalsByWorkspace: (workspaceId) => {
    const { terminals } = get();
    return Array.from(terminals.values()).filter(
      (t) => t.workspaceId === workspaceId
    );
  },
}));
