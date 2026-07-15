use crate::terminal_engine::frame::CursorPosition;
use vt100::Parser;

pub struct AnsiParser {
    parser: Parser,
}

impl AnsiParser {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            // scrollback kept small: live display is owned by xterm.js;
            // this parser is for snapshot restore on workspace remount.
            parser: Parser::new(rows, cols, 200),
        }
    }

    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// Resize the parser to match the PTY. Recreates the internal screen
    /// (state loss is acceptable for background sessions — xterm owns the UI).
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser = Parser::new(rows, cols, 200);
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Plain-text dump of the visible screen for rehydrating xterm on remount.
    pub fn screen_text(&self, rows: u16, cols: u16) -> String {
        let screen = self.parser.screen();
        let mut out = String::with_capacity((rows as usize + 1) * (cols as usize + 1));
        for r in 0..rows {
            let mut line = String::with_capacity(cols as usize);
            for c in 0..cols {
                if let Some(cell) = screen.cell(r, c) {
                    let ch = cell.contents().chars().next().unwrap_or(' ');
                    line.push(ch);
                } else {
                    line.push(' ');
                }
            }
            // Trim trailing spaces to keep the dump compact
            let trimmed = line.trim_end();
            out.push_str(trimmed);
            if r + 1 < rows {
                out.push('\r');
                out.push('\n');
            }
        }
        out
    }

    #[allow(dead_code)]
    pub fn cursor_position(&self) -> CursorPosition {
        let (row, col) = self.parser.screen().cursor_position();
        CursorPosition { row, col }
    }

    #[allow(dead_code)]
    pub fn window_title(&self) -> Option<String> {
        let title = self.parser.screen().title();
        if title.is_empty() {
            None
        } else {
            Some(title.to_string())
        }
    }
}
