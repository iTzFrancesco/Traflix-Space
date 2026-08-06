use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct AgentDetection {
    pub provider: String,
    pub source: String,
    pub confidence: f32,
}

const SUPPORTED_PROVIDERS: [&str; 5] = ["codex", "opencode", "claude", "pi", "freebuff"];

pub fn normalize_provider(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    SUPPORTED_PROVIDERS
        .iter()
        .find(|provider| **provider == normalized)
        .map(|provider| (*provider).to_string())
}

/// Detect an agent from the command written into a PTY. This deliberately
/// examines the command token rather than the shell name, so a normal
/// PowerShell prompt is never classified as an agent.
pub fn detect_from_command(input: &str) -> Option<AgentDetection> {
    for line in input
        .replace("\u{1b}[200~", "")
        .replace("\u{1b}[201~", "")
        .lines()
    {
        let mut tokens = line.split_whitespace();
        let Some(first_token) = tokens.next() else {
            continue;
        };
        let mut token = first_token.trim_matches(|c| c == '&' || c == '"' || c == '\'');
        token = token.trim_start_matches("./").trim_start_matches(".\\");

        // Common package-manager wrappers still leave a provider command as
        // the next meaningful token. `echo codex` and `powershell` do not.
        if matches!(
            token.to_ascii_lowercase().as_str(),
            "npx" | "pnpm" | "bunx" | "deno"
        ) {
            let Some(next_token) = tokens.next() else {
                continue;
            };
            token = next_token.trim_matches(|c| c == '"' || c == '\'');
        }

        let leaf = token.rsplit(['/', '\\']).next().unwrap_or(token);
        let leaf = leaf.strip_suffix(".exe").unwrap_or(leaf);
        if let Some(provider) = normalize_provider(leaf) {
            return Some(AgentDetection {
                provider,
                source: "command-observed".to_string(),
                confidence: 0.7,
            });
        }
    }
    None
}

/// Inspect the PTY child and its descendants on Windows. The query only
/// returns process identifiers and executable names; it does not classify the
/// shell itself and never exposes command-line data to the UI.
#[cfg(windows)]
pub fn detect_from_process_tree(root_pid: Option<u32>) -> Option<AgentDetection> {
    use serde::Deserialize;
    use std::process::Command;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct ProcessRow {
        process_id: u32,
        parent_process_id: u32,
        name: Option<String>,
    }

    let root_pid = root_pid?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let rows: Vec<ProcessRow> = match serde_json::from_slice(&output.stdout) {
        Ok(rows) => rows,
        Err(_) => serde_json::from_slice::<ProcessRow>(&output.stdout)
            .ok()
            .map(|row| vec![row])?,
    };

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut names = HashMap::new();
    for row in rows {
        children
            .entry(row.parent_process_id)
            .or_default()
            .push(row.process_id);
        if let Some(name) = row.name {
            names.insert(row.process_id, name);
        }
    }

    let mut queue = vec![root_pid];
    let mut visited = HashSet::new();
    while let Some(pid) = queue.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if pid != root_pid {
            if let Some(name) = names.get(&pid) {
                let leaf = name
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(name)
                    .strip_suffix(".exe")
                    .unwrap_or(name);
                if let Some(provider) = normalize_provider(leaf) {
                    return Some(AgentDetection {
                        provider,
                        source: "process-tree".to_string(),
                        confidence: 0.95,
                    });
                }
            }
        }
        if let Some(descendants) = children.get(&pid) {
            queue.extend(descendants.iter().copied());
        }
    }
    None
}

#[cfg(not(windows))]
pub fn detect_from_process_tree(_root_pid: Option<u32>) -> Option<AgentDetection> {
    None
}

#[cfg(test)]
mod tests {
    use super::{detect_from_command, normalize_provider};

    #[test]
    fn recognizes_supported_commands_without_classifying_powershell() {
        assert_eq!(
            detect_from_command("\r\ncodex --resume\r\n")
                .unwrap()
                .provider,
            "codex"
        );
        assert_eq!(
            detect_from_command("codex --resume\r\n").unwrap().provider,
            "codex"
        );
        assert_eq!(
            detect_from_command("npx opencode\r\n").unwrap().provider,
            "opencode"
        );
        assert!(detect_from_command("Get-ChildItem\r\n").is_none());
        assert!(detect_from_command("echo codex\r\n").is_none());
    }

    #[test]
    fn provider_names_are_bounded_to_supported_runtime_agents() {
        assert_eq!(normalize_provider("Pi").as_deref(), Some("pi"));
        assert_eq!(normalize_provider("freebuff").as_deref(), Some("freebuff"));
        assert!(normalize_provider("powershell").is_none());
    }
}
