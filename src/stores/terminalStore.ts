import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { useSkillStore } from "./skillStore";
import type { AgentTurnCompleted } from "../components/terminal/types";

export type AgentStatus = "idle" | "working" | "completed";

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
  agentStatus: AgentStatus;
  agentAttentionRequired: boolean;
  lastAgentCompletion: AgentTurnCompleted | null;
  /** Last viewport intent, retained while a workspace unmounts its xterm panes. */
  scrollPosition: TerminalScrollPosition;
}

export interface TerminalScrollPosition {
  followsOutput: boolean;
  /** Number of buffer rows between the viewport and the live bottom. */
  offsetFromBottom: number;
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
  /** When set, that terminal fills the workspace; others stay mounted but hidden. */
  focusedTerminalId: string | null;
  /** User-renamed titles (only in memory, not persisted).
   *  Key = terminal id, value = custom title.
   *  UI should check this first, then fall back to derived title. */
  terminalTitles: Record<string, string>;
  draggedTerminalId: string | null;
  dragHoveredTerminalId: string | null;

  addTerminal: (config: {
    id: string;
    workspaceId: string;
    shell: string;
    cwd: string;
    title: string;
    agent: string | null;
  }) => void;
  removeTerminal: (id: string) => void;
  /** Removes FE state and fires backend terminal_kill for each PTY (fire-and-forget). */
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  setFocusedTerminal: (id: string | null) => void;
  toggleFocusTerminal: (id: string) => void;
  /** Rename a terminal — stores the custom title in terminalTitles (memory only). */
  renameTerminal: (id: string, title: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (id: string) => void;
  markExited: (id: string, exitCode: number) => void;
  markAgentLaunched: (id: string) => void;
  markAgentInput: (id: string) => void;
  markAgentTurnCompleted: (
    id: string,
    event: AgentTurnCompleted,
    attentionRequired: boolean,
  ) => void;
  clearAgentAttention: (id: string) => void;
  saveScrollPosition: (id: string, position: TerminalScrollPosition) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
  setDraggedTerminalId: (id: string | null) => void;
  setDragHoveredTerminalId: (id: string | null) => void;
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
  focusedTerminalId: null,
  terminalTitles: {},
  draggedTerminalId: null,
  dragHoveredTerminalId: null,

  setDraggedTerminalId: (id) => set({ draggedTerminalId: id }),
  setDragHoveredTerminalId: (id) => set({ dragHoveredTerminalId: id }),

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
            agentStatus: "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
            scrollPosition: { followsOutput: true, offsetFromBottom: 0 },
          },
        },
      };
    }),

  removeTerminal: (id) =>
    set((state) => {
      const { [id]: removed, ...rest } = state.terminals;
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
        focusedTerminalId:
          state.focusedTerminalId === id ? null : state.focusedTerminalId,
      };
    }),

  killWorkspaceTerminals: (workspaceId) => {
    const idsToKill: string[] = [];
    const state = get();
    for (const [id, t] of Object.entries(state.terminals)) {
      if (t.workspaceId === workspaceId) {
        idsToKill.push(id);
      }
    }
    const skillStore = useSkillStore.getState();
    for (const id of idsToKill) {
      killBackendSession(id);
      skillStore.clearPendingDrop(id);
    }

    set((s) => {
      const next: Record<string, TerminalState> = {};
      let activeCleared = false;
      let focusCleared = false;
      for (const [id, t] of Object.entries(s.terminals)) {
        if (t.workspaceId === workspaceId) {
          if (s.activeTerminalId === id) activeCleared = true;
          if (s.focusedTerminalId === id) focusCleared = true;
          continue;
        }
        next[id] = t;
      }
      return {
        terminals: next,
        activeTerminalId: activeCleared ? null : s.activeTerminalId,
        focusedTerminalId: focusCleared ? null : s.focusedTerminalId,
      };
    });
  },

  // Only touch activeTerminalId — isActive on each entry is unused by selectors
  // (WorkspaceGrid compares against activeTerminalId). Avoids rewriting the Record.
  setActiveTerminal: (id) =>
    set((state) => {
      if (state.activeTerminalId === id) return state;
      return { activeTerminalId: id };
    }),

  setFocusedTerminal: (id) =>
    set((state) => {
      if (state.focusedTerminalId === id) return state;
      return { focusedTerminalId: id };
    }),

  toggleFocusTerminal: (id) =>
    set((state) => {
      const next = state.focusedTerminalId === id ? null : id;
      // Entering focus also activates the terminal.
      if (next) {
        return { focusedTerminalId: next, activeTerminalId: id };
      }
      return { focusedTerminalId: null };
    }),

  renameTerminal: (id, title) =>
    set((state) => {
      const trimmed = title.trim();
      if (!trimmed || !state.terminals[id]) return state;
      if (state.terminalTitles[id] === trimmed) return state;
      return {
        terminalTitles: { ...state.terminalTitles, [id]: trimmed },
      };
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
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            spawned: true,
            exitCode: null,
            agentAttentionRequired: false,
          },
        },
      };
    }),

  markExited: (id, exitCode) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            exitCode,
            spawned: false,
            agentStatus: "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
        focusedTerminalId:
          state.focusedTerminalId === id ? null : state.focusedTerminalId,
      };
    }),

  markAgentLaunched: (id) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.agentLaunched) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            agentLaunched: true,
            agentStatus: "working",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
      };
    }),

  markAgentInput: (id) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || !t.agentLaunched) return state;
      if (t.agentStatus === "working" && t.lastAgentCompletion === null) {
        return state;
      }
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            agentStatus: "working",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
      };
    }),

  markAgentTurnCompleted: (id, event, attentionRequired) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t) return state;
      if (t.lastAgentCompletion?.eventId && t.lastAgentCompletion.eventId === event.eventId) {
        return state;
      }
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            agentStatus: "completed",
            agentAttentionRequired: attentionRequired,
            lastAgentCompletion: event,
          },
        },
      };
    }),

  clearAgentAttention: (id) =>
    set((state) => {
      const t = state.terminals[id];
      if (
        !t ||
        (!t.agentAttentionRequired && t.agentStatus !== "completed")
      ) {
        return state;
      }
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            agentStatus: "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
      };
    }),

  saveScrollPosition: (id, position) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t) return state;
      const previous = t.scrollPosition;
      if (
        previous.followsOutput === position.followsOutput &&
        previous.offsetFromBottom === position.offsetFromBottom
      ) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: { ...t, scrollPosition: position },
        },
      };
    }),

  getByWorkspace: (workspaceId) => {
    const { terminals } = get();
    return Object.values(terminals).filter((t) => t.workspaceId === workspaceId);
  },
}));

export function useTerminalsByWorkspace(workspaceId: string) {
  return useStoreWithEqualityFn(
    useTerminalStore,
    (s) => Object.values(s.terminals).filter((t) => t.workspaceId === workspaceId),
    shallow,
  );
}
