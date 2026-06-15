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
    id: "aider",
    name: "Aider",
    description: "AI pair programming nel terminale",
    command: "aider",
    args: ["--model", "claude-3-5-sonnet-20241022"],
    env: {},
    icon: "Bot",
    color: "#e85d04",
    requiresApiKey: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
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
    id: "claude-code",
    name: "Claude Code",
    description: "Agente Claude ufficiale",
    command: "claude",
    args: [],
    env: {},
    icon: "MessageSquare",
    color: "#d97757",
    requiresApiKey: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "custom",
    name: "Comando Personalizzato",
    description: "Comando shell personalizzato",
    command: "",
    args: [],
    env: {},
    icon: "Settings",
    color: "#71717a",
    requiresApiKey: false,
  },
];
