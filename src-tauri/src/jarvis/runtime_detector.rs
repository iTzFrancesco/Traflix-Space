use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::sync::{Arc, OnceLock};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
// A prompt/reactivation scan may arrive while the periodic detector owns the
// gate. Wait long enough for a normal WMI query to finish instead of turning
// that expected overlap into a false stale-agent failure.
const PROCESS_TREE_SCAN_GATE_WAIT_MS: u64 = 2_500;
#[cfg(windows)]
const PROCESS_TREE_SCAN_TIMEOUT_SECS: u64 = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct AgentDetection {
    pub provider: String,
    pub source: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProcessTreeScan {
    pub detections: HashMap<u32, AgentDetection>,
    /// A provider launched through a JS/package shim may appear as `node.exe`.
    /// Only known launcher descendants count as presence when the provider
    /// cannot be recovered from the executable. Arbitrary background children
    /// of PowerShell must not keep an exited agent alive.
    pub roots_with_candidate_descendants: HashSet<u32>,
}

const SUPPORTED_PROVIDERS: [&str; 10] = [
    "anti-gravity",
    "claude",
    "claudex",
    "codex",
    "opencode",
    "pi",
    "cmdc",
    "cline",
    "freebuff",
    "grok",
];

pub fn normalize_provider(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let canonical = match normalized.as_str() {
        "agy" | "anti gravity" | "anti-gravity" | "antigravity" => "anti-gravity",
        "cloud" => "claude",
        "cloudx" => "claudex",
        "command code" => "cmdc",
        other => other,
    };
    SUPPORTED_PROVIDERS
        .iter()
        .find(|provider| **provider == canonical)
        .map(|provider| (*provider).to_string())
}

fn provider_from_executable(value: &str) -> Option<String> {
    normalize_provider(value)
}

/// Detect only the executable token of a complete shell command.
///
/// The PTY input path feeds this function only after its command buffer has
/// observed Enter. Keeping the parser here line-oriented also prevents words
/// in prompts, arguments, or arbitrary output from becoming agent identity.
/// Every known provider is recognized here so its launch command is never
/// misclassified as ordinary shell text.
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

fn is_agent_launcher_executable(value: &str) -> bool {
    normalize_executable(value).is_some_and(|leaf| {
        matches!(
            leaf.as_str(),
            "node" | "npm" | "npx" | "cmd" | "bun" | "deno"
        )
    })
}

#[cfg(windows)]
pub fn detect_from_process_tree_for_roots(root_pids: &[u32]) -> Result<ProcessTreeScan, String> {
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
        return Ok(ProcessTreeScan::default());
    }

    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("process-tree-query-failed: {error}"))?;
    if !output.status.success() {
        return Err("process-tree-query-failed: non-zero exit".to_string());
    }

    let rows: Vec<ProcessRow> = match serde_json::from_slice(&output.stdout) {
        Ok(rows) => rows,
        Err(_) => serde_json::from_slice::<ProcessRow>(&output.stdout)
            .ok()
            .map(|row| vec![row])
            .ok_or_else(|| "process-tree-query-failed: invalid JSON".to_string())?,
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

    let mut scan = ProcessTreeScan::default();
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
                        scan.detections.insert(
                            *root_pid,
                            AgentDetection {
                                provider,
                                source: "process-tree".to_string(),
                                confidence: 0.95,
                            },
                        );
                        break;
                    }
                    if is_agent_launcher_executable(name) {
                        scan.roots_with_candidate_descendants.insert(*root_pid);
                    }
                }
            }
            if let Some(descendants) = children.get(&pid) {
                queue.extend(descendants.iter().copied());
            }
        }
    }
    Ok(scan)
}

#[cfg(windows)]
fn process_tree_scan_gate() -> &'static Arc<tokio::sync::Semaphore> {
    static GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

#[cfg(windows)]
pub async fn scan_process_tree_async(root_pids: Vec<u32>) -> Result<ProcessTreeScan, String> {
    if root_pids.is_empty() {
        return Ok(ProcessTreeScan::default());
    }

    // `spawn_blocking` cannot cancel a PowerShell/WMI query after the async
    // timeout fires. The permit therefore lives inside the blocking closure:
    // a timed-out query keeps the single-flight gate until the OS call really
    // returns, instead of allowing a second full-system process enumeration to
    // overlap it. Callers that arrive while it is stuck fail fast and retry on
    // their normal detection cadence rather than accumulating queued workers.
    let permit = tokio::time::timeout(
        std::time::Duration::from_millis(PROCESS_TREE_SCAN_GATE_WAIT_MS),
        process_tree_scan_gate().clone().acquire_owned(),
    )
    .await
    .map_err(|_| "process-tree-query-busy".to_string())?
    .map_err(|_| "process-tree-query-gate-closed".to_string())?;

    let query = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        detect_from_process_tree_for_roots(&root_pids)
    });
    match tokio::time::timeout(
        std::time::Duration::from_secs(PROCESS_TREE_SCAN_TIMEOUT_SECS),
        query,
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("process-tree-query-join-failed: {error}")),
        Err(_) => Err("process-tree-query-timeout".to_string()),
    }
}

#[cfg(not(windows))]
pub async fn scan_process_tree_async(_root_pids: Vec<u32>) -> Result<ProcessTreeScan, String> {
    Ok(ProcessTreeScan::default())
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
            ("cloud --resume\r\n", "claude"),
            ("claudex --resume\r\n", "claudex"),
            ("cloudx --resume\r\n", "claudex"),
            ("bunx pi\r\n", "pi"),
            ("cmdc\r\n", "cmdc"),
            ("cline\r\n", "cline"),
            ("uvx freebuff\r\n", "freebuff"),
            ("grok\r\n", "grok"),
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
    fn provider_normalization_covers_every_jarvis_runtime_agent() {
        assert_eq!(normalize_provider("AGY").as_deref(), Some("anti-gravity"));
        assert_eq!(
            normalize_provider("anti gravity").as_deref(),
            Some("anti-gravity")
        );
        assert_eq!(normalize_provider("Pi").as_deref(), Some("pi"));
        assert_eq!(normalize_provider("freebuff").as_deref(), Some("freebuff"));
        assert_eq!(normalize_provider("Grok").as_deref(), Some("grok"));
        assert_eq!(normalize_provider("command code").as_deref(), Some("cmdc"));
        assert_eq!(normalize_provider("Cline").as_deref(), Some("cline"));
        assert_eq!(normalize_provider("CLAUDEX").as_deref(), Some("claudex"));
        assert_eq!(normalize_provider("Cloud").as_deref(), Some("claude"));
        assert_eq!(normalize_provider("CloudX").as_deref(), Some("claudex"));
        assert!(normalize_provider("powershell").is_none());
    }
}
