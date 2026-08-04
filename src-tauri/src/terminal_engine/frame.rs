use serde::{Deserialize, Serialize};

use crate::terminal_engine::cell::Cell;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub terminal_id: String,
    pub data: Vec<u8>,
    /// Monotonic chunk number within this PTY lifetime. It lets a frontend
    /// discard events already included in a rehydrate snapshot without
    /// dropping output that arrived after the snapshot cutover.
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRehydrateState {
    pub state: Vec<u8>,
    pub output_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    pub row: u16,
    pub col: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellUpdate {
    pub row: u16,
    pub col: u16,
    pub cell: Cell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDiff {
    pub terminal_id: String,
    pub cursor: CursorPosition,
    pub cursor_visible: bool,
    pub title: Option<String>,
    pub dirty_cells: Vec<CellUpdate>,
    pub scrolled_lines: u16,
    pub clear_screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSnapshot {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Vec<Cell>>,
    pub cursor: CursorPosition,
    pub cursor_visible: bool,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExited {
    pub terminal_id: String,
    pub exit_code: i32,
}
