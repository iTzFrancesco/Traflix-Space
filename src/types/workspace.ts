export interface WorkspaceConfig {
  id: string;
  name: string;
  rootPath: string;
  layout: GridLayout;
  terminals: TerminalConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface GridLayout {
  rows: number;
  cols: number;
}

export interface TerminalConfig {
  id: string;
  shell: string;
  agentId: string | null;
  command: string | null;
  cwd: string;
  title: string;
}
