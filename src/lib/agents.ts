export const MAX_CONCURRENT_AGENTS = 4;

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  icon: string;
  color: string;
}

export const AGENTS: AgentDefinition[] = [
  {
    id: "opencode",
    name: "OpenCode",
    description: "Agente AI con TUI avanzata",
    command: "opencode",
    args: [],
    icon: "Terminal",
    color: "#22c55e",
  },
  {
    id: "anti-gravity",
    name: "Anti-Gravity",
    description: "Agente AGY anti-gravity",
    command: "agy",
    args: [],
    icon: "Bot",
    color: "#06b6d4",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Agente AI Claude di Anthropic",
    command: "claude",
    args: [],
    icon: "MessageSquare",
    color: "#d97757",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Agente AI OpenAI Codex",
    command: "codex",
    args: [],
    icon: "Bot",
    color: "#6b46c1",
  },
  {
    id: "pi",
    name: "PI",
    description: "Agente AI PI",
    command: "pi",
    args: [],
    icon: "Bot",
    color: "#a855f7",
  },
];
