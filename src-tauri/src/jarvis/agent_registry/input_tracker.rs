//! Bounded reconstruction of the current input line in a shared agent TUI.
//!
//! Output never reaches this module. Unsupported cursor/editing sequences
//! invalidate the whole line so the registry cannot fabricate a task from a
//! suffix it cannot position reliably.

use super::MAX_INPUT_BUFFER_BYTES;

#[derive(Debug, Clone, Default)]
pub(super) struct InputTracker {
    text: String,
    escape: Vec<u8>,
    bracketed_paste: bool,
    unreliable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TrackerSignal {
    Committed(String),
    Interrupted,
}

impl InputTracker {
    fn reset(&mut self) {
        self.text.clear();
        self.escape.clear();
        self.bracketed_paste = false;
        self.unreliable = false;
    }

    fn invalidate_line(&mut self) {
        self.text.clear();
        self.escape.clear();
        self.bracketed_paste = false;
        self.unreliable = true;
    }

    fn pop_char(&mut self) {
        if !self.unreliable {
            self.text.pop();
        }
    }

    fn push_char(&mut self, ch: char) {
        if self.unreliable {
            return;
        }
        if self.text.len() + ch.len_utf8() > MAX_INPUT_BUFFER_BYTES {
            self.invalidate_line();
            return;
        }
        self.text.push(ch);
    }

    fn flush_printable(&mut self, printable: &mut Vec<u8>) {
        if printable.is_empty() {
            return;
        }
        if self.unreliable {
            printable.clear();
            return;
        }
        for ch in String::from_utf8_lossy(printable).chars() {
            self.push_char(ch);
            if self.unreliable {
                break;
            }
        }
        printable.clear();
    }

    fn finish_escape(&mut self, printable: &mut Vec<u8>) {
        let escape = std::mem::take(&mut self.escape);
        match escape.as_slice() {
            b"\x1b[200~" => self.bracketed_paste = true,
            b"\x1b[201~" => self.bracketed_paste = false,
            b"\x1b[3~" => {
                self.flush_printable(printable);
                self.pop_char();
            }
            _ => {
                self.flush_printable(printable);
                self.invalidate_line();
            }
        }
    }

    pub(super) fn feed(&mut self, data: &[u8]) -> Vec<TrackerSignal> {
        let mut signals = Vec::new();
        let mut printable: Vec<u8> = Vec::new();
        for &byte in data {
            if self.unreliable {
                if matches!(byte, b'\r' | b'\n' | 0x03) {
                    self.reset();
                }
                continue;
            }
            if !self.escape.is_empty() {
                self.escape.push(byte);
                if self.escape.len() > 32 {
                    self.invalidate_line();
                } else if self.escape.len() >= 3 && (0x40..=0x7e).contains(&byte) {
                    self.finish_escape(&mut printable);
                }
                continue;
            }
            if byte == 0x1b {
                self.flush_printable(&mut printable);
                self.escape.push(byte);
                continue;
            }
            match byte {
                b'\r' | b'\n' => {
                    self.flush_printable(&mut printable);
                    if self.unreliable {
                        self.reset();
                    } else if self.bracketed_paste {
                        self.text.push('\n');
                    } else if !self.text.is_empty() {
                        let text = std::mem::take(&mut self.text);
                        self.escape.clear();
                        self.bracketed_paste = false;
                        signals.push(TrackerSignal::Committed(text));
                    } else {
                        self.escape.clear();
                    }
                }
                b'\x08' | b'\x7f' => {
                    self.flush_printable(&mut printable);
                    self.pop_char();
                }
                0x03 => {
                    self.flush_printable(&mut printable);
                    let had_line = !self.text.is_empty() || self.bracketed_paste;
                    self.reset();
                    if had_line {
                        signals.push(TrackerSignal::Interrupted);
                    }
                }
                _ if byte.is_ascii_control() => {
                    self.flush_printable(&mut printable);
                    self.invalidate_line();
                }
                _ => printable.push(byte),
            }
        }
        self.flush_printable(&mut printable);
        signals
    }
}
