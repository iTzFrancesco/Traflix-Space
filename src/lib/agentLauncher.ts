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

class AgentLaunchQueue {
  private queue: Array<{ terminalId: string; agentId: string }> = [];
  private active = 0;
  private maxConcurrent = 2;

  enqueue(terminalId: string, agentId: string) {
    const terminal = useTerminalStore.getState().terminals[terminalId];
    if (!terminal) return;

    this.queue.push({ terminalId, agentId });
    setTimeout(() => this.processNext(), 1000);
  }

  private async processNext() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const { terminalId, agentId } = this.queue.shift()!;
    this.active++;
    try {
      const agent = AGENTS.find((a) => a.id === agentId);
      const terminal = useTerminalStore.getState().terminals[terminalId];
      if (agent && terminal) {
        const cmd = `${resolveAgentCommand(agent, terminal.shell)} ${agent.args.join(" ")}\r\n`;
        const encoder = new TextEncoder();
        await invoke("terminal_write", {
          terminalId,
          data: Array.from(encoder.encode(cmd)),
        });
      }
    } catch {
      // Agent launch failed silently
    } finally {
      this.active--;
      setTimeout(() => this.processNext(), 2000);
    }
  }
}

export const agentLaunchQueue = new AgentLaunchQueue();
