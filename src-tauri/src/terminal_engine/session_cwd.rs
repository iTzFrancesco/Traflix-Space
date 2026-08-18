use super::TerminalSession;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::info;

impl TerminalSession {
    /// Accumulate keystrokes and detect `cd` / `chdir` commands on Enter.
    /// Individual keystrokes arrive character-by-character (separate write()
    /// calls), so we buffer printable chars in cd_buffer.
    /// Paste / agent writes (text.len() > 10) are checked inline for `cd <path>`.
    pub(super) fn update_cwd_from_input(&self, data: &[u8]) {
        let text = match std::str::from_utf8(data) {
            Ok(t) => t,
            Err(_) => return,
        };

        // Check if this looks like a paste or agent command (multi-char write).
        let is_paste = text.contains("\x1b[200~");
        if is_paste || text.len() > 10 {
            // A paste can contain any supported command (`cd`, `chdir`,
            // `Set-Location`, `sl`), not just the literal `cd ` prefix.
            if let Some(p) = Self::extract_cd_path_from_input(text) {
                info!(
                    terminal_cwd_detected = "paste",
                    "Paste/agent cd command detected"
                );
                Self::resolve_and_update_cwd(&self.cwd, &self.cwd_changed, &p);
                return;
            }
            // Not a cd command — clear buffer to avoid cross-talk with keystrokes.
            if let Ok(mut buf) = self.cd_buffer.lock() {
                buf.clear();
            }
            return;
        }

        // Keystroke-by-keystroke: accumulate into buffer.
        let mut buf = match self.cd_buffer.lock() {
            Ok(b) => b,
            Err(_) => return,
        };

        for ch in text.chars() {
            match ch {
                '\r' | '\n' => {
                    let line = buf.clone();
                    let trimmed = line.trim().to_string();
                    buf.clear();
                    if !trimmed.is_empty() {
                        if let Some(p) = Self::extract_cd_path_from(&trimmed) {
                            info!(
                                terminal_cwd_detected = "keystroke",
                                "Keystroke cd command detected"
                            );
                            drop(buf);
                            Self::resolve_and_update_cwd(&self.cwd, &self.cwd_changed, &p);
                            return;
                        }
                    }
                }
                '\x08' | '\x7f' => {
                    buf.pop();
                }
                '\x1b' => {
                    // Escape sequence start — reset buffer
                    buf.clear();
                }
                c if c.is_control() => {
                    // Other control chars — reset buffer (safety)
                    buf.clear();
                }
                c => {
                    buf.push(c);
                }
            }
        }
    }

    /// Extract the path from a string starting with a cd-like command.
    /// Supports: `cd `, `chdir `, `CD `, `CHDIR `, `Set-Location `, `sl `.
    fn extract_cd_path_from(s: &str) -> Option<String> {
        // A terminal command must start with the cd-like verb. Searching inside
        // the input would incorrectly treat e.g. `echo cd .\\project` as a
        // directory change.
        let prefixes = [
            "cd ",
            "chdir ",
            "CD ",
            "CHDIR ",
            "Set-Location ",
            "set-location ",
            "sl ",
            "SL ",
        ];

        let command = s.trim_start_matches("\x1b[200~").trim_start();
        let remainder = prefixes
            .iter()
            .find_map(|prefix| command.strip_prefix(prefix))?;

        // Take up to \r or \n. A clipboard paste is wrapped in bracketed
        // paste markers, whose closing `ESC[201~` is not entirely control
        // characters and would otherwise be treated as part of the path.
        let line = remainder
            .split(|c: char| c == '\r' || c == '\n')
            .next()
            .unwrap_or("")
            .trim_end();
        let path = line
            .strip_suffix("\x1b[201~")
            .unwrap_or(line)
            .trim_end_matches(|c: char| c.is_control() || c.is_whitespace());

        if path.is_empty() || path == "~" {
            None
        } else {
            Some(path.to_string())
        }
    }

    /// Find the first directory-change command in a pasted multi-line input.
    /// Every line is still parsed from its start, so `echo cd ..` is never
    /// mistaken for a real directory change.
    fn extract_cd_path_from_input(input: &str) -> Option<String> {
        input
            .trim_start_matches("\x1b[200~")
            .split(|c: char| c == '\r' || c == '\n')
            .find_map(Self::extract_cd_path_from)
    }

    /// Resolve a path string (absolute or relative to cwd) and update cwd.
    /// Strips surrounding single/double quotes (PowerShell syntax).
    /// Handles Windows drive letters ("D:" → "D:\").
    /// Sets cwd_changed to true if the update succeeds.
    fn resolve_and_update_cwd(
        cwd_mutex: &std::sync::Mutex<String>,
        cwd_changed: &AtomicBool,
        path_str: &str,
    ) {
        // Strip one matching pair of PowerShell quotes while keeping path
        // separators intact (notably a drive root such as `C:\\`).
        let trimmed = path_str.trim();
        let cleaned = trimmed
            .strip_prefix('\'')
            .and_then(|path| path.strip_suffix('\''))
            .or_else(|| {
                trimmed
                    .strip_prefix('"')
                    .and_then(|path| path.strip_suffix('"'))
            })
            .unwrap_or(trimmed);

        // Detect Windows bare drive letter "D:" → make "D:\" absolute
        let expanded = if cleaned.len() == 2 && cleaned.chars().nth(1) == Some(':') {
            let mut d = cleaned.to_string();
            d.push('\\');
            d
        } else {
            cleaned.to_string()
        };

        let current_cwd = match cwd_mutex.lock() {
            Ok(g) => g.clone(),
            Err(_) => return,
        };
        let current = std::path::PathBuf::from(&current_cwd);

        let new_path = if std::path::Path::new(&expanded).is_absolute()
            || expanded.contains(":\\")
            || expanded.contains(":/")
        {
            std::path::PathBuf::from(&expanded)
        } else {
            current.join(&expanded)
        };

        match new_path.canonicalize() {
            Ok(canonical) => {
                // `canonicalize()` on Windows returns an extended-length path
                // (`\\?\C:\...`). Keep that internal implementation detail out
                // of shell commands, logs, and title-bar state.
                let new_cwd_str = canonical
                    .to_string_lossy()
                    .trim_start_matches("\\\\?\\")
                    .trim_start_matches("\\\\.\\")
                    .to_string();
                info!(
                    terminal_cwd_changed = true,
                    from = %current_cwd,
                    to = %new_cwd_str,
                    via = %path_str,
                    "CD detected — CWD updated"
                );
                if let Ok(mut cwd_guard) = cwd_mutex.lock() {
                    *cwd_guard = new_cwd_str;
                    cwd_changed.store(true, Ordering::Release);
                }
            }
            Err(e) => {
                info!(
                    terminal_cwd_resolve_failed = true,
                    error = %e,
                    "CD path canonicalize failed"
                );
            }
        }
    }
}
