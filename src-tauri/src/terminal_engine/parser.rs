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

    /// Full dump of scrollback history + visible screen for xterm rehydrate.
    ///
    /// Important: vt100's `Screen::contents()` only returns the *current
    /// viewport* (affected by `set_scrollback` offset), NOT the entire
    /// history. We walk the scrollback offset from oldest → newest and
    /// collect one top row per step, then append the live screen rows.
    ///
    /// Always leaves the view offset at 0 (live screen) when done.
    /// Capped at [`SCROLLBACK_LINES`] + viewport rows.
    pub fn rehydrate_text(&mut self) -> String {
        // Always restore live viewport offset, even on early return / panic paths.
        let result = self.rehydrate_text_inner();
        self.parser.set_scrollback(0);
        result
    }

    fn rehydrate_text_inner(&mut self) -> String {
        // Discover how many history rows are stored (set_scrollback clamps).
        self.parser.set_scrollback(usize::MAX);
        let max_off = self.parser.screen().scrollback();
        let cols = self.cols;
        let cap = SCROLLBACK_LINES.saturating_add(self.rows as usize);
        let mut lines: Vec<String> =
            Vec::with_capacity(cap.min(max_off + self.rows as usize + 1));

        // History lines (oldest first): at offset N the top visible row is
        // scrollback[scrollback_len - N]. Walking N from max_off → 1 yields
        // every history line exactly once.
        if max_off > 0 {
            for off in (1..=max_off).rev() {
                self.parser.set_scrollback(off);
                if let Some(line) = self.parser.screen().rows(0, cols).next() {
                    lines.push(trim_trailing_ws(line));
                }
            }
        }

        // Live screen (all viewport rows at offset 0).
        self.parser.set_scrollback(0);
        for line in self.parser.screen().rows(0, cols) {
            lines.push(trim_trailing_ws(line));
        }

        // Safety cap: keep the most recent lines only.
        let start = lines.len().saturating_sub(cap);
        let selected = &lines[start..];

        // Drop trailing empty lines (common at the bottom of a half-filled screen).
        let mut end = selected.len();
        while end > 0 && selected[end - 1].is_empty() {
            end -= 1;
        }
        if end == 0 {
            return String::new();
        }

        let mut out = String::with_capacity(end * (cols as usize / 2 + 2));
        for (i, line) in selected[..end].iter().enumerate() {
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

fn trim_trailing_ws(s: String) -> String {
    let trimmed = s.trim_end();
    if trimmed.len() == s.len() {
        s
    } else {
        trimmed.to_string()
    }
}
