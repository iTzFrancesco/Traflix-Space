export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  icon: string;
  color: string;
  requiresApiKey: boolean;
  apiKeyEnv?: string;
}

export const AGENTS: AgentDefinition[] = [
  {
    id: "gemini",
    name: "Gemini",
    description: "Agente AI Google Gemini",
    command: "gemini",
    args: [],
    env: {},
    icon: "Bot",
    color: "#4285F4",
    requiresApiKey: true,
    apiKeyEnv: "GEMINI_API_KEY",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Agente AI con TUI avanzata",
    command: "opencode",
    args: [],
    env: {},
    icon: "Terminal",
    color: "#22c55e",
    requiresApiKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Agente AI Claude di Anthropic",
    command: "claude",
    args: [],
    env: {},
    icon: "MessageSquare",
    color: "#d97757",
    requiresApiKey: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Agente AI OpenAI Codex",
    command: "codex",
    args: [],
    env: {},
    icon: "Bot",
    color: "#6b46c1",
    requiresApiKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anti-gravity",
    name: "Anti-Gravity",
    description: "Agente AGY anti-gravity",
    command: "agy",
    args: [],
    env: {},
    icon: "Bot",
    color: "#06b6d4",
    requiresApiKey: true,
    apiKeyEnv: "AGY_API_KEY",
  },
];
