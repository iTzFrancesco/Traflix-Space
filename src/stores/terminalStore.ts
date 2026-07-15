import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { useSkillStore } from "./skillStore";

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
  /** Removes FE state and fires backend terminal_kill for each PTY (fire-and-forget). */
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (id: string) => void;
  markExited: (id: string, exitCode: number) => void;
  markAgentLaunched: (id: string) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
}

/** Best-effort backend PTY kill — never throws into the store. */
function killBackendSession(terminalId: string) {
  invoke("terminal_kill", { terminalId }).catch(() => {
    // Session may already be gone (natural exit / double-kill).
  });
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
      const { [id]: removed, ...rest } = state.terminals;
      // Se stiamo rimuovendo il terminale attivo, attiva un altro terminale
      // nello stesso workspace (se presente)
      let newActive = state.activeTerminalId;
      if (newActive === id) {
        const workspaceId = removed?.workspaceId;
        if (workspaceId) {
          const sameWs = Object.values(rest).find(
            (t) => t.workspaceId === workspaceId,
          );
          newActive = sameWs?.id ?? null;
        } else {
          newActive = null;
        }
      }
      return {
        terminals: rest,
        activeTerminalId: newActive,
      };
    }),

  killWorkspaceTerminals: (workspaceId) => {
    // Collect IDs first so we can kill backend PTYs even after state is cleared.
    const idsToKill: string[] = [];
    const state = get();
    for (const [id, t] of Object.entries(state.terminals)) {
      if (t.workspaceId === workspaceId) {
        idsToKill.push(id);
      }
    }
    // CRITICAL: previously this only removed Zustand entries and left ConPTY
    // child processes + reader threads alive → RAM/CPU leak after open/close cycles.
    const skillStore = useSkillStore.getState();
    for (const id of idsToKill) {
      killBackendSession(id);
      skillStore.clearPendingDrop(id);
    }

    set((s) => {
      const next: Record<string, TerminalState> = {};
      let activeCleared = false;
      for (const [id, t] of Object.entries(s.terminals)) {
        if (t.workspaceId === workspaceId) {
          if (s.activeTerminalId === id) activeCleared = true;
          continue;
        }
        next[id] = t;
      }
      return {
        terminals: next,
        activeTerminalId: activeCleared ? null : s.activeTerminalId,
      };
    });
  },

  setActiveTerminal: (id) =>
    set((state) => {
      if (state.activeTerminalId === id) return state;
      // Only rewrite the two affected entries (not the entire Record).
      const next = { ...state.terminals };
      const prevId = state.activeTerminalId;
      if (prevId && next[prevId]) {
        next[prevId] = { ...next[prevId], isActive: false };
      }
      if (next[id]) {
        next[id] = { ...next[id], isActive: true };
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
        terminals: { ...state.terminals, [id]: { ...t, spawned: true, exitCode: null } },
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
