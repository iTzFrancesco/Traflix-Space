use serde::{Deserialize, Serialize};

use crate::terminal_engine::cell::Cell;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub terminal_id: String,
    pub data: Vec<u8>,
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
