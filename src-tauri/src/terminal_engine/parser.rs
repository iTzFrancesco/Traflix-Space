use crate::terminal_engine::frame::CursorPosition;
use vt100::Parser;

/// Max scrollback rows kept per session for workspace remount rehydrate.
/// Matches xterm.js scrollback so frontend/backend stay aligned.
pub const SCROLLBACK_LINES: usize = 1000;

pub struct AnsiParser {
    parser: Parser,
    cols: u16,
    rows: u16,
}

impl AnsiParser {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: Parser::new(rows, cols, SCROLLBACK_LINES),
            cols,
            rows,
        }
    }

    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// Resize the terminal without wiping scrollback history.
    /// Uses vt100 `set_size` instead of recreating the parser.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        if self.cols == cols && self.rows == rows {
            return;
        }
        self.parser.set_size(rows, cols);
        self.cols = cols;
        self.rows = rows;
        // Pin view to the live screen (offset 0).
        self.parser.set_scrollback(0);
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Visible screen only, formatted for xterm rehydrate.
    ///
    /// Important: this deliberately excludes scrollback history. Including
    /// scrollback caused the bug where a cleared terminal repopulated old
    /// output after a workspace remount. Only the current live screen is
    /// returned so the frontend sees exactly what the user last saw.
    pub fn screen_text_for_rehydrate(&mut self) -> String {
        // Always restore live viewport offset, even on early return / panic paths.
        let result = self.screen_text_for_rehydrate_inner();
        self.parser.set_scrollback(0);
        result
    }

    // Recover only the current visible screen for xterm rehydrate.
    //
    // We intentionally do NOT include the VT100 scrollback history here.
    // Including scrollback caused the bug where a cleared terminal (e.g.
    // `clear` in PowerShell) would still show old output after switching
    // workspaces, because the scrollback kept the old lines while the live
    // screen was empty. Returning only the live screen preserves the
    // cleared state on remount.
    fn screen_text_for_rehydrate_inner(&mut self) -> String {
        self.parser.set_scrollback(0);
        let cols = self.cols;
        let mut lines: Vec<String> = Vec::with_capacity(self.rows as usize);

        for line in self.parser.screen().rows_formatted(0, cols) {
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }

        let mut end = lines.len();
        while end > 0 && strip_ansi(&lines[end - 1]).trim_end().is_empty() {
            end -= 1;
        }
        if end == 0 {
            return String::new();
        }

        let mut out = String::with_capacity(end * (cols as usize / 2 + 2));
        for (i, line) in lines[..end].iter().enumerate() {
            if i > 0 {
                out.push('\r');
                out.push('\n');
            }
            out.push_str(line);
        }
        out
    }

    /// Visible screen only (no scrollback) — lightweight helper.
    #[allow(dead_code)]
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

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.next() == Some('[') {
            for c in chars.by_ref() {
                if c >= '\x40' && c <= '\x7E' {
                    break;
                }
            }
        } else if c != '\x1b' {
            out.push(c);
        }
    }
    out
}
