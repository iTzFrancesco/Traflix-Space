import type { TerminalConfig } from "../../stores/terminalStore";

export interface LoadedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  layout: { rows: number; cols: number };
  terminals: TerminalConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface TerminalCloseRequest {
  terminalId: string;
  token: number;
}

export interface WorkspaceTerminalsRef {
  workspaceId: string | null;
  terminals: TerminalConfig[];
}
