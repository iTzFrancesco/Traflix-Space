use crate::terminal_engine::frame::CursorPosition;
use vt100::Parser;

pub struct AnsiParser {
    parser: Parser,
}

impl AnsiParser {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: Parser::new(rows, cols, 0),
        }
    }

    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    #[allow(dead_code)]
    pub fn cursor_position(&self) -> CursorPosition {
        let (row, col) = self.parser.screen().cursor_position();
        CursorPosition {
            row: row as u16,
            col: col as u16,
        }
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
