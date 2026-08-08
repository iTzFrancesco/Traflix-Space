import { invoke } from "@tauri-apps/api/core";
import { AGENTS, type AgentDefinition } from "./agents";
import { useTerminalStore } from "../stores/terminalStore";

function shellFamily(shell: string): string {
  const executable = shell.replace(/\\/g, "/").split("/").pop() ?? shell;
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)) return "powershell";
  if (/^cmd(?:\.exe)?$/i.test(executable)) return "cmd";
  return "powershell";
}

function resolveAgentCommand(agent: AgentDefinition, shell: string): string {
  return agent.commandByShell?.[shellFamily(shell)] ?? agent.command;
}

interface QueuedLaunch {
  terminalId: string;
  agentId: string;
  attempt: number;
}

const MAX_LAUNCH_ATTEMPTS = 2;
const INITIAL_LAUNCH_DELAY_MS = 1000;
const RETRY_DELAY_MS = 1200;

function rollbackLaunchState(terminalId: string) {
  useTerminalStore.setState((state) => {
    const terminal = state.terminals[terminalId];
    if (!terminal) return state;
    return {
      terminals: {
        ...state.terminals,
        [terminalId]: {
          ...terminal,
          agentLaunched: false,
          agentStatus: "idle",
          agentAttentionRequired: false,
          lastAgentCompletion: null,
        },
      },
    };
  });
}

class AgentLaunchQueue {
  private queue: QueuedLaunch[] = [];
  private queuedTerminals = new Set<string>();
  private active = 0;
  private readonly maxConcurrent = 2;
  private wakeTimer: number | null = null;

  enqueue(terminalId: string, agentId: string) {
    const terminal = useTerminalStore.getState().terminals[terminalId];
    if (!terminal || this.queuedTerminals.has(terminalId)) return;

    this.queuedTerminals.add(terminalId);
    this.queue.push({ terminalId, agentId, attempt: 1 });
    this.schedule(INITIAL_LAUNCH_DELAY_MS);
  }

  private schedule(delayMs: number) {
    if (this.wakeTimer !== null) return;
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      this.processAvailable();
    }, delayMs);
  }

  private processAvailable() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const launch = this.queue.shift();
      if (!launch) break;
      this.active += 1;
      void this.run(launch);
    }
  }

  private async run(launch: QueuedLaunch) {
    const { terminalId, agentId } = launch;
    let retry = false;

    try {
      const agent = AGENTS.find((candidate) => candidate.id === agentId);
      const terminal = useTerminalStore.getState().terminals[terminalId];
      if (!agent || !terminal || terminal.exitCode !== null) {
        rollbackLaunchState(terminalId);
        return;
      }

      const cmd = `${resolveAgentCommand(agent, terminal.shell)} ${agent.args.join(" ")}\r\n`;
      const encoder = new TextEncoder();
      await invoke("terminal_write", {
        terminalId,
        data: Array.from(encoder.encode(cmd)),
      });
    } catch (error) {
      if (
        launch.attempt < MAX_LAUNCH_ATTEMPTS &&
        useTerminalStore.getState().terminals[terminalId]
      ) {
        retry = true;
        this.queue.push({ ...launch, attempt: launch.attempt + 1 });
      } else {
        rollbackLaunchState(terminalId);
        console.warn(`[agent-launch] failed for ${terminalId}`, error);
      }
    } finally {
      this.active -= 1;
      if (!retry) this.queuedTerminals.delete(terminalId);
      if (this.queue.length > 0) {
        this.schedule(retry ? RETRY_DELAY_MS : 0);
      }
    }
  }
}

export const agentLaunchQueue = new AgentLaunchQueue();

// A manual "Riapri terminale" creates a fresh PTY generation but TerminalPane
// stays mounted, so its normal mount-time launch effect does not run again.
// Detect exactly the exited -> spawned transition and relaunch the configured
// agent after the current event turn. Jarvis-owned restarts mark agentLaunched
// synchronously after markSpawned; the deferred check therefore observes true
// and never starts a duplicate CLI.
useTerminalStore.subscribe((state, previous) => {
  for (const [terminalId, terminal] of Object.entries(state.terminals)) {
    const before = previous.terminals[terminalId];
    if (
      !before ||
      before.exitCode === null ||
      terminal.exitCode !== null ||
      !terminal.spawned ||
      !terminal.agent
    ) {
      continue;
    }

    const agentId = terminal.agent;
    window.setTimeout(() => {
      const liveStore = useTerminalStore.getState();
      const live = liveStore.terminals[terminalId];
      if (
        !live ||
        !live.spawned ||
        live.exitCode !== null ||
        live.agent !== agentId ||
        live.agentLaunched
      ) {
        return;
      }
      liveStore.markAgentLaunched(terminalId);
      agentLaunchQueue.enqueue(terminalId, agentId);
    }, 0);
  }
});
