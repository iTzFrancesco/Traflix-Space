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

export interface AgentLaunchConfig {
  workspaceId: string;
  terminalId: string;
  agentId: string;
  cwd: string;
}
