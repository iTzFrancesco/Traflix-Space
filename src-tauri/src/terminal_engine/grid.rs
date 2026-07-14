#![allow(dead_code)]

use crate::terminal_engine::cell::Cell;
use crate::terminal_engine::frame::{CursorPosition, FrameSnapshot};

pub struct GridBuffer {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Vec<Cell>>,
    pub scrollback_limit: usize,
    pub cursor: CursorPosition,
    pub title: String,
}

impl GridBuffer {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cells = vec![vec![Cell::default(); cols as usize]; rows as usize];
        Self {
            cols,
            rows,
            cells,
            scrollback_limit: 10000,
            cursor: CursorPosition { row: 0, col: 0 },
            title: String::new(),
        }
    }

    pub fn put_char(&mut self, ch: char) {
        let row = self.cursor.row as usize;
        let col = self.cursor.col as usize;
        if row < self.cells.len() && col < self.cells[row].len() {
            self.cells[row][col].ch = ch;
        }
        self.cursor.col += 1;
        if self.cursor.col >= self.cols {
            self.cursor.col = 0;
            self.cursor.row += 1;
            if self.cursor.row >= self.rows {
                self.scroll_up(1);
                self.cursor.row = (self.rows - 1) as u16;
            }
        }
    }

    pub fn scroll_up(&mut self, count: u16) {
        let count = count as usize;
        if count >= self.cells.len() {
            for row in self.cells.iter_mut() {
                for cell in row.iter_mut() {
                    *cell = Cell::default();
                }
            }
            return;
        }
        for _ in 0..count {
            self.cells.remove(0);
            self.cells.push(vec![Cell::default(); self.cols as usize]);
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let mut new_cells = Vec::with_capacity(rows as usize);
        for r in 0..rows {
            let mut row = Vec::with_capacity(cols as usize);
            for c in 0..cols {
                let r_idx = r as usize;
                let c_idx = c as usize;
                if r_idx < self.cells.len() && c_idx < self.cells[r_idx].len() {
                    row.push(self.cells[r_idx][c_idx].clone());
                } else {
                    row.push(Cell::default());
                }
            }
            new_cells.push(row);
        }
        self.cols = cols;
        self.rows = rows;
        self.cells = new_cells;
        if self.cursor.row >= rows {
            self.cursor.row = rows - 1;
        }
        if self.cursor.col >= cols {
            self.cursor.col = cols - 1;
        }
    }

    pub fn put_text(&mut self, text: &str) {
        for c in text.chars() {
            match c {
                '\n' | '\r' => {
                    self.cursor.col = 0;
                    self.cursor.row += 1;
                    if self.cursor.row >= self.rows {
                        self.scroll_up(1);
                        self.cursor.row = (self.rows - 1) as u16;
                    }
                }
                '\t' => {
                    let tab_stops = 8;
                    let next = ((self.cursor.col as usize / tab_stops) + 1) * tab_stops;
                    self.cursor.col = (next.min(self.cols as usize - 1)) as u16;
                }
                '\x08' => {
                    if self.cursor.col > 0 {
                        self.cursor.col -= 1;
                    }
                }
                _ if c.is_ascii_control() => {}
                _ => {
                    self.put_char(c);
                }
            }
        }
    }

    pub fn clear(&mut self) {
        for row in self.cells.iter_mut() {
            for cell in row.iter_mut() {
                *cell = Cell::default();
            }
        }
        self.cursor = CursorPosition { row: 0, col: 0 };
    }

    pub fn clear_line(&mut self, row: u16) {
        if let Some(line) = self.cells.get_mut(row as usize) {
            for cell in line.iter_mut() {
                *cell = Cell::default();
            }
        }
    }

    pub fn snapshot(&self, terminal_id: &str) -> FrameSnapshot {
        FrameSnapshot {
            terminal_id: terminal_id.to_string(),
            cols: self.cols,
            rows: self.rows,
            cells: self.cells.clone(),
            cursor: self.cursor.clone(),
            cursor_visible: true,
            title: self.title.clone(),
        }
    }

    pub fn get_scrollback(&self, offset: usize, limit: usize) -> Vec<Vec<Cell>> {
        let total = self.cells.len();
        if offset >= total {
            return Vec::new();
        }
        let start = total.saturating_sub(offset + limit);
        let end = total.saturating_sub(offset);
        self.cells[start..end].to_vec()
    }
}
