export interface WorkspacePreset {
  id: string;
  name: string;
  description: string;
  terminalCount: number;
  agentCount: number;
  layout: { rows: number; cols: number };
  shell: string;
  agentId: string | null;
}

export const PRESETS: WorkspacePreset[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Workspace vuoto con un solo terminale",
    terminalCount: 1,
    agentCount: 0,
    layout: { rows: 1, cols: 1 },
    shell: "bash",
    agentId: null,
  },
  {
    id: "fullstack",
    name: "Full-Stack Dev",
    description: "Frontend, Backend, Database e AI",
    terminalCount: 4,
    agentCount: 1,
    layout: { rows: 2, cols: 2 },
    shell: "bash",
    agentId: "aider",
  },
  {
    id: "api-server",
    name: "API Server",
    description: "Server, Test e AI",
    terminalCount: 3,
    agentCount: 1,
    layout: { rows: 1, cols: 3 },
    shell: "bash",
    agentId: "aider",
  },
  {
    id: "ai-swarm",
    name: "AI Agent Swarm",
    description: "Multi-agent parallelo",
    terminalCount: 4,
    agentCount: 4,
    layout: { rows: 2, cols: 2 },
    shell: "bash",
    agentId: "aider",
  },
  {
    id: "devops",
    name: "DevOps",
    description: "Docker, Kubernetes e AI",
    terminalCount: 3,
    agentCount: 1,
    layout: { rows: 1, cols: 3 },
    shell: "bash",
    agentId: "opencode",
  },
  {
    id: "data-science",
    name: "Data Science",
    description: "Python, Jupyter e AI",
    terminalCount: 3,
    agentCount: 1,
    layout: { rows: 1, cols: 3 },
    shell: "bash",
    agentId: "aider",
  },
];
