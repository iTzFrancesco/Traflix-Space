import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "./agents";

class AgentLaunchQueue {
  private queue: Array<{ terminalId: string; agentId: string }> = [];
  private active = 0;
  private maxConcurrent = 2;

  enqueue(terminalId: string, agentId: string) {
    this.queue.push({ terminalId, agentId });
    setTimeout(() => this.processNext(), 1000);
  }

  private async processNext() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const { terminalId, agentId } = this.queue.shift()!;
    this.active++;
    try {
      const agent = AGENTS.find((a) => a.id === agentId);
      if (agent) {
        const cmd = `${agent.command} ${agent.args.join(" ")}\r\n`;
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
