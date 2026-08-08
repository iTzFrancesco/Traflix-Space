use std::collections::HashMap;
#[cfg(windows)]
use std::collections::HashSet;

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

fn manual_provider_from_executable(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "agy" => Some("anti-gravity".to_string()),
        "cmdc" => Some("cmdc".to_string()),
        "cline" => Some("cline".to_string()),
        _ => None,
    }
}

fn provider_from_executable(value: &str) -> Option<String> {
    normalize_provider(value).or_else(|| manual_provider_from_executable(value))
}

/// Detect only the executable token of a complete shell command.
///
/// The PTY input path feeds this function only after its command buffer has
/// observed Enter. Keeping the parser here line-oriented also prevents words
/// in prompts, arguments, or arbitrary output from becoming agent identity.
/// Manual-only agents are recognized here so their launch command is never
/// misclassified as a task; `normalize_provider` deliberately does not promote
/// them to readiness-verified Jarvis providers.
pub fn detect_from_command(input: &str) -> Option<AgentDetection> {
    let normalized_input = input.replace("\u{1b}[200~", "").replace("\u{1b}[201~", "");
    let line = normalized_input
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut tokens = line.split_whitespace();
    let first = normalize_executable(tokens.next()?)?;

    let provider = match first.as_str() {
        "npx" | "bunx" | "uvx" => next_provider_token(&mut tokens)
            .and_then(|candidate| provider_from_executable(&candidate)),
        "pnpm" => {
            let mut token = tokens.next();
            while let Some(value) = token {
                let normalized = normalize_executable(value);
                if normalized.as_deref() == Some("exec") {
                    token = tokens.next();
                    break;
                }
                if normalized.as_deref() == Some("run") {
                    // A package script is not proof that this provider was
                    // launched; only the explicit `pnpm exec` form is safe.
                    return None;
                }
                if normalized
                    .as_deref()
                    .and_then(provider_from_executable)
                    .is_some()
                {
                    break;
                }
                if !value.starts_with('-') {
                    break;
                }
                token = tokens.next();
            }
            token.and_then(|candidate| provider_from_executable(&candidate))
        }
        "deno" => {
            // `deno run npm:codex` and `deno codex` are both common wrappers.
            next_provider_token(&mut tokens)
                .and_then(|candidate| provider_from_executable(&candidate))
        }
        provider => provider_from_executable(provider),
    }?;

    Some(AgentDetection {
        provider,
        source: "command-observed".to_string(),
        confidence: 0.7,
    })
}

fn next_provider_token<'a>(tokens: &mut impl Iterator<Item = &'a str>) -> Option<String> {
    for value in tokens {
        let candidate = normalize_executable(value)?;
        if candidate.starts_with('-') || candidate == "run" || candidate == "exec" {
            continue;
        }
        if provider_from_executable(&candidate).is_some() {
            return Some(candidate);
        }
        // A wrapper's first non-flag token is the executable. If it is not a
        // known provider, do not search arbitrary arguments for a name.
        return None;
    }
    None
}

fn normalize_executable(value: &str) -> Option<String> {
    let value = value
        .trim_matches(|c| c == '&' || c == '"' || c == '\'')
        .trim_start_matches("./")
        .trim_start_matches(".\\");
    let value = value.strip_prefix("npm:").unwrap_or(value);
    let leaf = value.rsplit(['/', '\\']).next().unwrap_or(value);
    let leaf = leaf.to_ascii_lowercase();
    let leaf = leaf.strip_suffix(".exe").unwrap_or(&leaf);
    (!leaf.is_empty()).then(|| leaf.to_string())
}

#[cfg(windows)]
pub fn detect_from_process_tree_for_roots(root_pids: &[u32]) -> HashMap<u32, AgentDetection> {
    use serde::Deserialize;
    use std::process::Command;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct ProcessRow {
        process_id: u32,
        parent_process_id: u32,
        name: Option<String>,
    }

    if root_pids.is_empty() {
        return HashMap::new();
    }

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
        ])
        .output()
        .ok();
    let Some(output) = output else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }

    let rows: Vec<ProcessRow> = match serde_json::from_slice(&output.stdout) {
        Ok(rows) => rows,
        Err(_) => serde_json::from_slice::<ProcessRow>(&output.stdout)
            .ok()
            .map(|row| vec![row])
            .unwrap_or_default(),
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

    let mut detections = HashMap::new();
    for root_pid in root_pids {
        let mut queue = vec![*root_pid];
        let mut visited = HashSet::new();
        while let Some(pid) = queue.pop() {
            if !visited.insert(pid) {
                continue;
            }
            if pid != *root_pid {
                if let Some(name) = names.get(&pid) {
                    if let Some(provider) =
                        normalize_executable(name).and_then(|leaf| normalize_provider(&leaf))
                    {
                        detections.insert(
                            *root_pid,
                            AgentDetection {
                                provider,
                                source: "process-tree".to_string(),
                                confidence: 0.95,
                            },
                        );
                        break;
                    }
                }
            }
            if let Some(descendants) = children.get(&pid) {
                queue.extend(descendants.iter().copied());
            }
        }
    }
    detections
}

#[cfg(windows)]
pub async fn detect_from_process_tree_async(root_pids: Vec<u32>) -> HashMap<u32, AgentDetection> {
    let query = tokio::task::spawn_blocking(move || detect_from_process_tree_for_roots(&root_pids));
    match tokio::time::timeout(std::time::Duration::from_secs(2), query).await {
        Ok(Ok(result)) => result,
        _ => HashMap::new(),
    }
}

#[cfg(not(windows))]
pub async fn detect_from_process_tree_async(_root_pids: Vec<u32>) -> HashMap<u32, AgentDetection> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::{detect_from_command, normalize_provider};

    #[test]
    fn recognizes_launch_commands_without_classifying_arbitrary_shell_text() {
        let expected = [
            ("agy\r\n", "anti-gravity"),
            ("codex --resume\r\n", "codex"),
            ("npx -y opencode\r\n", "opencode"),
            ("pnpm exec claude\r\n", "claude"),
            ("bunx pi\r\n", "pi"),
            ("cmdc\r\n", "cmdc"),
            ("cline\r\n", "cline"),
            ("uvx freebuff\r\n", "freebuff"),
            ("deno run codex\r\n", "codex"),
            ("deno run npm:codex\r\n", "codex"),
        ];
        for (command, provider) in expected {
            let detection = detect_from_command(command).expect(command);
            assert_eq!(detection.provider, provider, "{command}");
            assert_eq!(detection.source, "command-observed");
            assert_eq!(detection.confidence, 0.7);
        }
        for command in [
            "Get-ChildItem\r\n",
            "echo codex\r\n",
            "powershell codex\r\n",
            "pnpm run codex\r\n",
            "pnpm install codex\r\n",
        ] {
            assert!(detect_from_command(command).is_none(), "{command}");
        }
    }

    #[test]
    fn executable_normalization_handles_windows_paths_and_extensions() {
        let detection = detect_from_command("C:\\tools\\CODEX.EXE --resume\r\n")
            .expect("Windows executable path should be recognized");
        assert_eq!(detection.provider, "codex");
        assert_eq!(
            detect_from_command("'./agy'\r\n")
                .expect("quoted executable")
                .provider,
            "anti-gravity"
        );
    }

    #[test]
    fn provider_normalization_is_bounded_to_readiness_verified_runtime_agents() {
        assert_eq!(normalize_provider("Pi").as_deref(), Some("pi"));
        assert_eq!(normalize_provider("freebuff").as_deref(), Some("freebuff"));
        for manual_only in ["agy", "anti-gravity", "cmdc", "command code", "cline"] {
            assert!(normalize_provider(manual_only).is_none(), "{manual_only}");
        }
        assert!(normalize_provider("powershell").is_none());
    }
}
