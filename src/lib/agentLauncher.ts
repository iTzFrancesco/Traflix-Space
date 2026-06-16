import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "./agents";

class AgentLaunchQueue {
  private queue: Array<{ terminalId: string; agentId: string }> = [];
  private active = 0;
  private maxConcurrent = 2;

  enqueue(terminalId: string, agentId: string) {
    this.queue.push({ terminalId, agentId });
    this.processNext();
  }

  private async processNext() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const { terminalId, agentId } = this.queue.shift()!;
    this.active++;
    try {
      const agent = AGENTS.find((a) => a.id === agentId);
      if (agent) {
        await invoke("terminal_write", {
          terminalId,
          data: `${agent.command} ${agent.args.join(" ")}\r\n`,
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
