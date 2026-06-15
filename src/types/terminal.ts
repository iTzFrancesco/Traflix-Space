export interface TerminalState {
  id: string;
  workspaceId: string;
  ptyId: string | null;
  title: string;
  process: string;
  agent: string | null;
  isActive: boolean;
  shell: string;
  cwd: string;
}

export interface TerminalInfo {
  id: string;
  cols: number;
  rows: number;
  pid: number;
  shell: string;
}
