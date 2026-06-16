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
