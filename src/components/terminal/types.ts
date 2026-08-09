export interface TerminalCell {
  ch: string;
  fg: { r: number; g: number; b: number };
  bg: { r: number; g: number; b: number };
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface CursorPosition {
  row: number;
  col: number;
}

export interface CellUpdate {
  row: number;
  col: number;
  cell: TerminalCell;
}

export interface FrameDiff {
  terminalId: string;
  cursor: CursorPosition;
  cursorVisible: boolean;
  title: string | null;
  dirtyCells: CellUpdate[];
  scrolledLines: number;
  clearScreen: boolean;
}

export interface FrameSnapshot {
  terminalId: string;
  cols: number;
  rows: number;
  cells: TerminalCell[][];
  cursor: CursorPosition;
  cursorVisible: boolean;
  title: string;
}

export interface TerminalOutput {
  terminalId: string;
  /** Workspace owning this exact PTY lifetime. */
  workspaceId: string;
  /** PTY lifetime; stale events from an older reopen are ignored. */
  generation: number;
  /** OS process identity for the same PTY lifetime, when available. */
  processId: number | null;
  data: number[];
  sequence: number;
  /** Frontend batching overflowed; discard local bytes and take a new snapshot. */
  resyncRequired?: boolean;
  resyncReason?: "frontend-queue-overflow";
  /** Internal batch metadata retained so rehydrate can filter exact chunks. */
  chunks?: Array<{
    workspaceId: string;
    generation: number;
    processId: number | null;
    sequence: number;
    data: Uint8Array;
  }>;
}

export interface TerminalRehydrateState {
  workspaceId: string;
  /** PTY lifetime represented by this snapshot. */
  generation: number;
  processId: number | null;
  history: number[];
  state: number[];
  outputSequence: number;
  cols: number;
  rows: number;
}

export interface TerminalExited {
  terminalId: string;
  workspaceId: string;
  /** PTY lifetime; stale exit notifications must not close a reopened pane. */
  generation: number;
  processId: number | null;
  exitCode: number;
}

export interface TerminalRuntimeIdentity {
  workspaceId: string;
  generation: number;
  processId: number | null;
  agentLaunchOwner: "backend" | null;
  agentLaunchState: "starting" | "ready" | "failed" | null;
}

export interface AgentTurnCompleted {
  protocol: number;
  provider: string;
  kind: "turn_completed";
  terminalId: string;
  generation?: number | null;
  processId?: number | null;
  eventId?: string | null;
  workspaceId?: string | null;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  cwd?: string | null;
  occurredAt?: string | null;
}
