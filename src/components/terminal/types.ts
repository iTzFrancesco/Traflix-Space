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
  data: number[];
  sequence: number;
  /** Internal batch metadata retained so rehydrate can filter exact chunks. */
  chunks?: Array<{ sequence: number; data: Uint8Array }>;
}

export interface TerminalRehydrateState {
  history: number[];
  state: number[];
  outputSequence: number;
  cols: number;
  rows: number;
}

export interface TerminalExited {
  terminalId: string;
  exitCode: number;
}

export interface AgentTurnCompleted {
  protocol: number;
  provider: string;
  kind: "turn_completed";
  terminalId: string;
  generation?: number | null;
  eventId?: string | null;
  workspaceId?: string | null;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  cwd?: string | null;
  occurredAt?: string | null;
}
