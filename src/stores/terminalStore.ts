import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { useSkillStore } from "./skillStore";
import type { AgentTurnCompleted } from "../components/terminal/types";
import { canonicalTerminalIds } from "../lib/terminalOrdering";
import type { TerminalScrollPosition } from "../lib/terminalScrollState";
import { reportFrontendDiagnostic } from "../lib/crashDiagnostics";

export type { TerminalScrollPosition } from "../lib/terminalScrollState";

export type AgentStatus = "idle" | "working" | "completed";

export interface TerminalState {
  id: string;
  workspaceId: string;
  title: string;
  shell: string;
  cwd: string;
  agent: string | null;
  generation: number | null;
  processId: number | null;
  isActive: boolean;
  spawned: boolean;
  exitCode: number | null;
  agentLaunched: boolean;
  agentLaunchOwner: "frontend" | "backend" | null;
  backendLaunchState: "starting" | "ready" | "failed" | null;
  agentStatus: AgentStatus;
  agentAttentionRequired: boolean;
  lastAgentCompletion: AgentTurnCompleted | null;
  /** Last viewport intent, retained while a workspace unmounts its xterm panes. */
  scrollPosition: TerminalScrollPosition;
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
  terminalOrderByWorkspace: Record<string, string[]>;
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
  removeTerminal: (id: string, expectedGeneration?: number) => void;
  /** Removes FE state and fires backend terminal_kill for each PTY (fire-and-forget). */
  killWorkspaceTerminals: (workspaceId: string) => void;
  setActiveTerminal: (id: string) => void;
  setFocusedTerminal: (id: string | null) => void;
  toggleFocusTerminal: (id: string) => void;
  /** Rename a terminal — stores the custom title in terminalTitles (memory only). */
  renameTerminal: (id: string, title: string) => void;
  updateTitle: (id: string, title: string) => void;
  markSpawned: (
    id: string,
    workspaceId: string,
    generation: number,
    processId?: number | null,
  ) => void;
  markExited: (
    id: string,
    workspaceId: string,
    generation: number,
    processId: number | null,
    exitCode: number,
  ) => void;
  markAgentLaunched: (id: string, generation: number) => void;
  markBackendAgentLaunch: (
    id: string,
    workspaceId: string,
    generation: number,
    processId: number | null,
    launchState: "starting" | "ready" | "failed",
  ) => void;
  markAgentInput: (id: string) => void;
  markAgentTurnCompleted: (
    id: string,
    event: AgentTurnCompleted,
    attentionRequired: boolean,
  ) => void;
  clearAgentAttention: (id: string) => void;
  saveScrollPosition: (
    id: string,
    expectedGeneration: number | null,
    position: TerminalScrollPosition,
  ) => void;
  syncWorkspaceTerminalOrder: (workspaceId: string, terminalIds: string[]) => void;
  getByWorkspace: (workspaceId: string) => TerminalState[];
  setDraggedTerminalId: (id: string | null) => void;
  setDragHoveredTerminalId: (id: string | null) => void;
}

/** Best-effort backend PTY kill — never throws into the store. */
function killBackendSession(terminal: TerminalState) {
  if (terminal.generation === null) return;
  invoke("terminal_kill", {
    terminalId: terminal.id,
    workspaceId: terminal.workspaceId,
    generation: terminal.generation,
    processId: terminal.processId,
  }).catch((error) => {
    // Session may already be gone (natural exit / double-kill), but retaining
    // the identity in the persistent diagnostic log makes a genuine orphaned
    // child process distinguishable from that harmless race.
    reportFrontendDiagnostic("terminal-kill-error", error, {
      terminalId: terminal.id,
      workspaceId: terminal.workspaceId,
      generation: terminal.generation ?? undefined,
      processId: terminal.processId,
      state: "workspace-cleanup",
    });
  });
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  terminals: {},
  terminalOrderByWorkspace: {},
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
            generation: null,
            processId: null,
            isActive: false,
            spawned: false,
            exitCode: null,
            agentLaunched: false,
            agentLaunchOwner: null,
            backendLaunchState: null,
            agentStatus: "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
            scrollPosition: { followsOutput: true, offsetFromBottom: 0 },
          },
        },
        terminalOrderByWorkspace: {
          ...state.terminalOrderByWorkspace,
          [config.workspaceId]: canonicalTerminalIds(
            state.terminalOrderByWorkspace[config.workspaceId] ?? [],
            [
              ...Object.values(state.terminals)
                .filter((terminal) => terminal.workspaceId === config.workspaceId)
                .map((terminal) => terminal.id),
              config.id,
            ],
          ),
        },
      };
    }),

  removeTerminal: (id, expectedGeneration) =>
    set((state) => {
      const candidate = state.terminals[id];
      if (
        !candidate ||
        (expectedGeneration !== undefined && candidate.generation !== expectedGeneration)
      ) {
        return state;
      }
      const { [id]: removed, ...rest } = state.terminals;
      let newActive = state.activeTerminalId;
      if (newActive === id) {
        const workspaceId = removed?.workspaceId;
        if (workspaceId) {
          const runtimeIds = Object.values(rest)
            .filter((terminal) => terminal.workspaceId === workspaceId)
            .map((terminal) => terminal.id);
          newActive = canonicalTerminalIds(
            state.terminalOrderByWorkspace[workspaceId] ?? [],
            runtimeIds,
          )[0] ?? null;
        } else {
          newActive = null;
        }
      }
      return {
        terminals: rest,
        activeTerminalId: newActive,
        focusedTerminalId:
          state.focusedTerminalId === id ? null : state.focusedTerminalId,
        terminalOrderByWorkspace: removed
          ? {
              ...state.terminalOrderByWorkspace,
              [removed.workspaceId]: (state.terminalOrderByWorkspace[removed.workspaceId] ?? [])
                .filter((terminalId) => terminalId !== id),
            }
          : state.terminalOrderByWorkspace,
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
      const terminal = state.terminals[id];
      if (terminal && terminal.generation !== null) {
        killBackendSession(terminal);
      }
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
        terminalOrderByWorkspace: Object.fromEntries(
          Object.entries(s.terminalOrderByWorkspace).filter(([id]) => id !== workspaceId),
        ),
      };
    });
  },

  // Only touch activeTerminalId — isActive on each entry is unused by selectors
  // (WorkspaceGrid compares against activeTerminalId). Avoids rewriting the Record.
  setActiveTerminal: (id) =>
    set((state) => {
      if (state.activeTerminalId === id) return state;
      if (!state.terminals[id]) return state;
      return { activeTerminalId: id };
    }),

  setFocusedTerminal: (id) =>
    set((state) => {
      if (state.focusedTerminalId === id) return state;
      if (id !== null && !state.terminals[id]) return state;
      return { focusedTerminalId: id };
    }),

  toggleFocusTerminal: (id) =>
    set((state) => {
      const next = state.focusedTerminalId === id ? null : id;
      if (next && !state.terminals[id]) return state;
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

  markSpawned: (id, workspaceId, generation, processId = null) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.workspaceId !== workspaceId) return state;
      if (t.generation !== null && t.generation > generation) return state;
      if (
        t.generation === generation &&
        t.processId !== null &&
        t.processId !== processId
      ) return state;
      if (
        t.spawned &&
        t.exitCode === null &&
        t.generation === generation &&
        t.processId === processId
      ) return state;
      const generationChanged = t.generation !== generation;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            generation,
            processId,
            spawned: true,
            exitCode: null,
            agentLaunched: generationChanged ? false : t.agentLaunched,
            agentLaunchOwner: generationChanged ? null : t.agentLaunchOwner,
            backendLaunchState: generationChanged ? null : t.backendLaunchState,
            agentStatus: generationChanged ? "idle" : t.agentStatus,
            agentAttentionRequired: false,
            lastAgentCompletion: generationChanged ? null : t.lastAgentCompletion,
            scrollPosition: generationChanged
              ? { followsOutput: true, offsetFromBottom: 0 }
              : t.scrollPosition,
          },
        },
      };
    }),

  markExited: (id, workspaceId, generation, processId, exitCode) =>
    set((state) => {
      const t = state.terminals[id];
      if (
        !t ||
        t.workspaceId !== workspaceId ||
        t.generation !== generation ||
        t.processId !== processId
      ) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            exitCode,
            spawned: false,
            // A fresh PTY generation must prove/launch its agent again. Jarvis
            // marks this true authoritatively after backend-owned restarts;
            // manual reopens are recovered by the frontend launch queue.
            agentLaunched: false,
            agentLaunchOwner: null,
            backendLaunchState: null,
            agentStatus: "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
        focusedTerminalId:
          state.focusedTerminalId === id ? null : state.focusedTerminalId,
      };
    }),

  markAgentLaunched: (id, generation) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.generation !== generation || t.agentLaunched) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            agentLaunched: true,
            agentLaunchOwner: "frontend",
            backendLaunchState: null,
            agentStatus: "working",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
          },
        },
      };
    }),

  markBackendAgentLaunch: (id, workspaceId, generation, processId, launchState) =>
    set((state) => {
      const t = state.terminals[id];
      if (
        !t ||
        t.workspaceId !== workspaceId ||
        (t.generation !== null && t.generation > generation) ||
        (t.generation === generation &&
          t.processId !== null &&
          t.processId !== processId) ||
        (t.generation === generation &&
          (t.backendLaunchState === "ready" || t.backendLaunchState === "failed") &&
          launchState === "starting") ||
        (t.generation === generation &&
          t.backendLaunchState === "ready" &&
          launchState === "failed")
      ) return state;
      const generationChanged = t.generation !== generation;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...t,
            generation,
            processId,
            spawned: true,
            exitCode: null,
            agentLaunched: launchState === "ready",
            agentLaunchOwner: "backend",
            backendLaunchState: launchState,
            agentStatus: launchState === "ready" ? "working" : "idle",
            agentAttentionRequired: false,
            lastAgentCompletion: null,
            scrollPosition: generationChanged
              ? { followsOutput: true, offsetFromBottom: 0 }
              : t.scrollPosition,
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
      if (
        event.generation == null ||
        t.generation !== event.generation ||
        event.processId !== t.processId ||
        event.workspaceId !== t.workspaceId
      ) return state;
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

  saveScrollPosition: (id, expectedGeneration, position) =>
    set((state) => {
      const t = state.terminals[id];
      if (!t || t.generation !== expectedGeneration) return state;
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

  syncWorkspaceTerminalOrder: (workspaceId, terminalIds) =>
    set((state) => {
      const runtimeIds = Object.values(state.terminals)
        .filter((terminal) => terminal.workspaceId === workspaceId)
        .map((terminal) => terminal.id);
      const nextOrder = canonicalTerminalIds(terminalIds, runtimeIds);
      const current = state.terminalOrderByWorkspace[workspaceId] ?? [];
      if (
        current.length === nextOrder.length &&
        current.every((id, index) => id === nextOrder[index])
      ) return state;
      return {
        terminalOrderByWorkspace: {
          ...state.terminalOrderByWorkspace,
          [workspaceId]: nextOrder,
        },
      };
    }),

  getByWorkspace: (workspaceId) => {
    const { terminals, terminalOrderByWorkspace } = get();
    const runtimeIds = Object.values(terminals)
      .filter((terminal) => terminal.workspaceId === workspaceId)
      .map((terminal) => terminal.id);
    return canonicalTerminalIds(terminalOrderByWorkspace[workspaceId] ?? [], runtimeIds)
      .map((id) => terminals[id])
      .filter((terminal): terminal is TerminalState => Boolean(terminal));
  },
}));

export function useTerminalsByWorkspace(workspaceId: string) {
  return useStoreWithEqualityFn(
    useTerminalStore,
    (s) => {
      const runtimeIds = Object.values(s.terminals)
        .filter((terminal) => terminal.workspaceId === workspaceId)
        .map((terminal) => terminal.id);
      return canonicalTerminalIds(s.terminalOrderByWorkspace[workspaceId] ?? [], runtimeIds)
        .map((id) => s.terminals[id])
        .filter((terminal): terminal is TerminalState => Boolean(terminal));
    },
    shallow,
  );
}
