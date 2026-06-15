import { create } from "zustand";

export interface TerminalState {
  id: string;
  workspaceId: string;
  ptyId: string | null;
  title: string;
  process: string;
  agent: string | null;
  isActive: boolean;
  outputBuffer: string[];
}

interface TerminalStore {
  terminals: Map<string, TerminalState>;
  activeTerminalId: string | null;

  createTerminal: (config: Omit<TerminalState, "id">) => string;
  killTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTerminalTitle: (id: string, title: string) => void;
  writeToTerminal: (id: string, data: string) => void;
}

export const useTerminalStore = create<TerminalStore>()((set, _get) => ({
  terminals: new Map(),
  activeTerminalId: null,

  createTerminal: (config) => {
    const id = crypto.randomUUID();
    set((state) => ({
      terminals: new Map(state.terminals).set(id, { ...config, id, outputBuffer: [] }),
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

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  updateTerminalTitle: (id, title) =>
    set((state) => {
      const next = new Map(state.terminals);
      const terminal = next.get(id);
      if (terminal) {
        next.set(id, { ...terminal, title });
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
}));
