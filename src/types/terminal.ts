export interface TerminalState {
  id: string;
  workspaceId: string;
  ptyId: string | null;
  title: string;
  process: string;
  agent: string | null;
  isActive: boolean;
}

export interface TerminalInfo {
  id: string;
  cols: number;
  rows: number;
  pid: number | null;
}
