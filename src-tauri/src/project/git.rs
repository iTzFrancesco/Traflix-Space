use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_ACTION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DIFF_BYTES: usize = 256 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitStatus {
    pub workspace_id: String,
    pub repository_state: GitRepositoryState,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub changes: Vec<ProjectGitChange>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRepositoryState {
    Repository,
    NotRepository,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitChange {
    pub path: String,
    pub rename_from: Option<String>,
    pub index: GitChangeState,
    pub worktree: GitChangeState,
    pub untracked: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitDiff {
    pub workspace_id: String,
    pub path: String,
    pub side: String,
    pub patch: String,
    pub additions: i32,
    pub deletions: i32,
    pub binary: bool,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitChangeState {
    Clean,
    Added,
    Modified,
    Deleted,
    Renamed,
    Conflict,
}

#[derive(Debug)]
enum GitFailure {
    NotInstalled,
    Timeout,
    Spawn(String),
}

impl GitFailure {
    fn message(&self) -> String {
        match self {
            Self::NotInstalled => "Git non è installato o non è disponibile nel PATH".to_string(),
            Self::Timeout => "Git ha superato il timeout di 10 secondi".to_string(),
            Self::Spawn(error) => format!("Impossibile avviare Git: {error}"),
        }
    }
}

pub async fn status_for_workspace(
    workspace_id: String,
    workspace_root: PathBuf,
) -> Result<ProjectGitStatus, String> {
    let repository_output = match run_git(&workspace_root, &["rev-parse", "--show-toplevel"]).await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let error = output_error(&output);
            if is_not_repository_error(&error) {
                return Ok(empty_status(
                    workspace_id,
                    GitRepositoryState::NotRepository,
                    None,
                ));
            }
            return Ok(empty_status(
                workspace_id,
                GitRepositoryState::Error,
                Some(error),
            ));
        }
        Err(GitFailure::NotInstalled) => {
            return Ok(empty_status(
                workspace_id,
                GitRepositoryState::Unavailable,
                Some("Git non è installato o non è disponibile nel PATH".to_string()),
            ));
        }
        Err(error) => {
            return Ok(empty_status(
                workspace_id,
                GitRepositoryState::Error,
                Some(error.message()),
            ));
        }
    };

    let repository_root = std::fs::canonicalize(
        String::from_utf8_lossy(&repository_output.stdout)
            .trim()
            .to_string(),
    )
    .map_err(|error| format!("Impossibile risolvere la root Git: {error}"))?;
    let workspace_prefix = workspace_relative_prefix(&repository_root, &workspace_root)?;

    let status_output = match run_git(
        &repository_root,
        &["status", "--porcelain=2", "-z", "--branch"],
    )
    .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return Ok(empty_status(
                workspace_id,
                GitRepositoryState::Error,
                Some(output_error(&output)),
            ));
        }
        Err(error) => {
            return Ok(empty_status(
                workspace_id,
                GitRepositoryState::Error,
                Some(error.message()),
            ));
        }
    };

    let mut status = parse_porcelain_v2(&status_output.stdout, &workspace_prefix);
    status.workspace_id = workspace_id;
    status.repository_state = GitRepositoryState::Repository;
    Ok(status)
}

pub async fn repository_root_for_workspace(workspace_root: &Path) -> Option<PathBuf> {
    let output = run_git(workspace_root, &["rev-parse", "--show-toplevel"])
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    std::fs::canonicalize(String::from_utf8_lossy(&output.stdout).trim().to_string()).ok()
}

pub async fn diff_for_workspace(
    workspace_id: String,
    workspace_root: PathBuf,
    relative_path: String,
    side: String,
) -> Result<ProjectGitDiff, String> {
    let repository_root = repository_root_for_workspace(&workspace_root)
        .await
        .ok_or_else(|| "La workspace non appartiene a un repository Git".to_string())?;
    let workspace_prefix = workspace_relative_prefix(&repository_root, &workspace_root)?;
    let repository_path = repository_relative_path(&workspace_prefix, &relative_path)?;
    let (side_name, staged) = match side.as_str() {
        "worktree" => ("worktree", false),
        "staged" => ("staged", true),
        _ => return Err("Lato diff non valido".to_string()),
    };

    let mut diff_args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-color".to_string(),
        "--binary".to_string(),
    ];
    if staged {
        diff_args.push("--cached".to_string());
    }
    diff_args.push("--".to_string());
    diff_args.push(repository_path.clone());
    let diff_output = run_git_owned(&repository_root, diff_args)
        .await
        .map_err(|error| error.message())?;
    if !diff_output.status.success() {
        return Err(output_error(&diff_output));
    }

    let mut stat_args = vec!["diff".to_string(), "--numstat".to_string()];
    if staged {
        stat_args.push("--cached".to_string());
    }
    stat_args.push("--".to_string());
    stat_args.push(repository_path);
    let stat_output = run_git_owned(&repository_root, stat_args)
        .await
        .map_err(|error| error.message())?;
    if !stat_output.status.success() {
        return Err(output_error(&stat_output));
    }

    let raw_patch = String::from_utf8_lossy(&diff_output.stdout).into_owned();
    let mut truncated = raw_patch.len() > MAX_DIFF_BYTES;
    let mut patch = if truncated {
        raw_patch.chars().take(MAX_DIFF_BYTES).collect()
    } else {
        raw_patch
    };
    let (mut additions, mut deletions, mut binary) = parse_numstat(&stat_output.stdout);

    if patch.is_empty() && side_name == "worktree" {
        if let Some((
            untracked_patch,
            untracked_additions,
            untracked_deletions,
            untracked_binary,
            untracked_truncated,
        )) = untracked_file_diff(&workspace_root, &relative_path)
        {
            patch = untracked_patch;
            additions = untracked_additions;
            deletions = untracked_deletions;
            binary = untracked_binary;
            truncated = untracked_truncated;
        }
    }

    Ok(ProjectGitDiff {
        workspace_id,
        path: relative_path,
        side: side_name.to_string(),
        patch,
        additions,
        deletions,
        binary,
        truncated,
        error: None,
    })
}

pub async fn stage_for_workspace(
    workspace_root: PathBuf,
    paths: Vec<String>,
) -> Result<(), String> {
    run_path_action(workspace_root, "add", paths).await
}

pub async fn unstage_for_workspace(
    workspace_root: PathBuf,
    paths: Vec<String>,
) -> Result<(), String> {
    run_path_action(workspace_root, "restore --staged", paths).await
}

pub async fn discard_for_workspace(
    workspace_root: PathBuf,
    paths: Vec<String>,
) -> Result<(), String> {
    let repository_root = repository_root_for_workspace(&workspace_root)
        .await
        .ok_or_else(|| "La workspace non appartiene a un repository Git".to_string())?;
    let workspace_prefix = workspace_relative_prefix(&repository_root, &workspace_root)?;
    let repository_paths = repository_paths(&workspace_prefix, paths)?;
    let tracked_paths = tracked_paths_for(&repository_root, &repository_paths).await?;

    if !tracked_paths.is_empty() {
        let mut restore_args = vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        restore_args.extend(tracked_paths);
        run_git_action(&repository_root, restore_args).await?;
    }

    let mut clean_args = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
    clean_args.extend(repository_paths);
    run_git_action(&repository_root, clean_args).await
}

pub async fn commit_for_workspace(
    workspace_root: PathBuf,
    message: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Il messaggio di commit non può essere vuoto".to_string());
    }
    let repository_root = repository_root_for_workspace(&workspace_root)
        .await
        .ok_or_else(|| "La workspace non appartiene a un repository Git".to_string())?;
    let workspace_prefix = workspace_relative_prefix(&repository_root, &workspace_root)?;
    let repository_paths = repository_paths(&workspace_prefix, paths)?;
    let mut args = vec![
        "commit".to_string(),
        "-m".to_string(),
        message.trim().to_string(),
        "--".to_string(),
    ];
    args.extend(repository_paths);
    run_git_action(&repository_root, args).await
}

pub async fn sync_for_workspace(workspace_root: PathBuf, action: String) -> Result<(), String> {
    let repository_root = repository_root_for_workspace(&workspace_root)
        .await
        .ok_or_else(|| "La workspace non appartiene a un repository Git".to_string())?;
    let upstream = run_git(
        &repository_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await
    .map_err(|error| error.message())?;
    if !upstream.status.success() {
        return Err("Configura un upstream remoto prima di usare Pull o Push".to_string());
    }
    let args = match action.as_str() {
        "pull" => vec!["pull".to_string(), "--ff-only".to_string()],
        "push" => vec!["push".to_string()],
        _ => return Err("Azione Git non valida".to_string()),
    };
    run_git_action(&repository_root, args).await
}

async fn run_path_action(
    workspace_root: PathBuf,
    action: &str,
    paths: Vec<String>,
) -> Result<(), String> {
    let repository_root = repository_root_for_workspace(&workspace_root)
        .await
        .ok_or_else(|| "La workspace non appartiene a un repository Git".to_string())?;
    let workspace_prefix = workspace_relative_prefix(&repository_root, &workspace_root)?;
    let repository_paths = repository_paths(&workspace_prefix, paths)?;
    let mut args: Vec<String> = action.split(' ').map(ToString::to_string).collect();
    args.push("--".to_string());
    args.extend(repository_paths);
    run_git_action(&repository_root, args).await
}

fn repository_paths(workspace_prefix: &str, paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Seleziona almeno un file".to_string());
    }
    paths
        .into_iter()
        .map(|path| repository_relative_path(workspace_prefix, &path))
        .collect()
}

async fn tracked_paths_for(
    repository_root: &Path,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "ls-files".to_string(),
        "--cached".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    let output = run_git_owned(repository_root, args)
        .await
        .map_err(|error| error.message())?;
    if !output.status.success() {
        return Err(output_error(&output));
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect())
}

async fn run_git_action(cwd: &Path, args: Vec<String>) -> Result<(), String> {
    let output = run_git_owned_with_timeout(cwd, args, GIT_ACTION_TIMEOUT)
        .await
        .map_err(|error| error.message())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(output_error(&output))
    }
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, GitFailure> {
    run_git_owned(
        cwd,
        args.iter()
            .map(|argument| (*argument).to_string())
            .collect(),
    )
    .await
}

async fn run_git_owned(cwd: &Path, args: Vec<String>) -> Result<Output, GitFailure> {
    run_git_owned_with_timeout(cwd, args, GIT_TIMEOUT).await
}

async fn run_git_owned_with_timeout(
    cwd: &Path,
    args: Vec<String>,
    timeout_duration: Duration,
) -> Result<Output, GitFailure> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV)
        .env_remove(crate::settings::secrets::GROQ_API_KEY_ENV)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = timeout(timeout_duration, command.output())
        .await
        .map_err(|_| GitFailure::Timeout)?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitFailure::NotInstalled
            } else {
                GitFailure::Spawn(error.to_string())
            }
        })?;
    Ok(output)
}

fn empty_status(
    workspace_id: String,
    repository_state: GitRepositoryState,
    error: Option<String>,
) -> ProjectGitStatus {
    ProjectGitStatus {
        workspace_id,
        repository_state,
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
        error,
    }
}

fn output_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("Git ha restituito il codice {}", output.status)
    } else {
        stderr
    }
}

fn is_not_repository_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("not a git repository")
        || normalized.contains("non è una directory git")
        || normalized.contains("not a repository")
}

fn workspace_relative_prefix(
    repository_root: &Path,
    workspace_root: &Path,
) -> Result<String, String> {
    let relative = workspace_root
        .strip_prefix(repository_root)
        .map_err(|_| "La workspace non è contenuta nella root Git".to_string())?;
    Ok(to_frontend_path(relative))
}

fn parse_porcelain_v2(raw: &[u8], workspace_prefix: &str) -> ProjectGitStatus {
    let mut status = empty_status(String::new(), GitRepositoryState::Repository, None);
    let records: Vec<&[u8]> = raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut index = 0;

    while index < records.len() {
        let record = String::from_utf8_lossy(records[index]).into_owned();
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            status.head = (!value.is_empty() && value != "(initial)").then(|| value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.head ") {
            status.branch =
                (value != "(detached)" && value != "(unknown)").then(|| value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut values = value.split_whitespace();
            status.ahead = values
                .next()
                .and_then(|item| item.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            status.behind = values
                .next()
                .and_then(|item| item.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            let is_rename = record.starts_with("2 ");
            let path_index = if is_rename { 9 } else { 8 };
            let fields: Vec<&str> = record.splitn(path_index + 1, ' ').collect();
            if fields.len() > path_index {
                let xy = fields[1].as_bytes();
                if let Some(path) = to_workspace_path(fields[path_index], workspace_prefix) {
                    let conflict = is_conflict(xy);
                    let rename_from = if is_rename && index + 1 < records.len() {
                        let source = String::from_utf8_lossy(records[index + 1]);
                        index += 1;
                        to_workspace_path(&source, workspace_prefix)
                    } else {
                        None
                    };
                    status.changes.push(ProjectGitChange {
                        path,
                        rename_from,
                        index: state_from_status(xy.first().copied().unwrap_or(b'.'), conflict),
                        worktree: state_from_status(xy.get(1).copied().unwrap_or(b'.'), conflict),
                        untracked: false,
                        binary: false,
                    });
                }
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            if let Some(path) = to_workspace_path(path, workspace_prefix) {
                status.changes.push(ProjectGitChange {
                    path,
                    rename_from: None,
                    index: GitChangeState::Clean,
                    worktree: GitChangeState::Added,
                    untracked: true,
                    binary: false,
                });
            }
        }
        index += 1;
    }

    status
        .changes
        .sort_by(|left, right| left.path.cmp(&right.path));
    status
}

fn state_from_status(value: u8, conflict: bool) -> GitChangeState {
    if conflict && value != b'.' {
        return GitChangeState::Conflict;
    }
    match value {
        b'A' => GitChangeState::Added,
        b'M' => GitChangeState::Modified,
        b'D' => GitChangeState::Deleted,
        b'R' | b'C' => GitChangeState::Renamed,
        b'U' => GitChangeState::Conflict,
        _ => GitChangeState::Clean,
    }
}

fn is_conflict(xy: &[u8]) -> bool {
    xy.first().is_some_and(|value| *value == b'U')
        || xy.get(1).is_some_and(|value| *value == b'U')
        || matches!(xy, b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU")
}

fn to_workspace_path(repo_path: &str, workspace_prefix: &str) -> Option<String> {
    let normalized = normalize_git_path(repo_path);
    if workspace_prefix.is_empty() {
        return (!normalized.is_empty()).then_some(normalized);
    }

    let prefix = format!("{workspace_prefix}/");
    let normalized_lower = normalized.to_lowercase();
    let prefix_lower = prefix.to_lowercase();
    normalized_lower
        .starts_with(&prefix_lower)
        .then(|| normalized[prefix.len()..].to_string())
        .filter(|path| !path.is_empty())
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn repository_relative_path(workspace_prefix: &str, relative_path: &str) -> Result<String, String> {
    let normalized = normalize_git_path(relative_path);
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Percorso file non valido".to_string());
    }
    if workspace_prefix.is_empty() {
        return Ok(normalized);
    }
    Ok(format!("{workspace_prefix}/{normalized}"))
}

fn parse_numstat(raw: &[u8]) -> (i32, i32, bool) {
    let text = String::from_utf8_lossy(raw);
    let line = text.lines().next().unwrap_or_default();
    let mut fields = line.split('\t');
    let additions = fields.next().unwrap_or_default();
    let deletions = fields.next().unwrap_or_default();
    if additions == "-" && deletions == "-" {
        return (0, 0, true);
    }
    (
        additions.parse().unwrap_or(0),
        deletions.parse().unwrap_or(0),
        false,
    )
}

fn untracked_file_diff(
    workspace_root: &Path,
    relative_path: &str,
) -> Option<(String, i32, i32, bool, bool)> {
    let candidate = relative_path
        .split('/')
        .fold(workspace_root.to_path_buf(), |path, component| {
            path.join(component)
        });
    let canonical = std::fs::canonicalize(candidate).ok()?;
    if !canonical.starts_with(workspace_root) || !canonical.is_file() {
        return None;
    }

    let bytes = std::fs::read(canonical).ok()?;
    if bytes.contains(&0) {
        return Some((String::new(), 0, 0, true, false));
    }

    let text = String::from_utf8_lossy(&bytes);
    let line_count = if text.is_empty() {
        0
    } else {
        text.lines().count() as i32
    };
    let added_lines = text
        .lines()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let raw_patch = format!(
        "diff --git a/{relative_path} b/{relative_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative_path}\n@@ -0,0 +1,{line_count} @@\n{added_lines}"
    );
    let truncated = raw_patch.len() > MAX_DIFF_BYTES;
    let patch = if truncated {
        raw_patch.chars().take(MAX_DIFF_BYTES).collect()
    } else {
        raw_patch
    };
    Some((patch, line_count, 0, false, truncated))
}

fn to_frontend_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value == "." {
        String::new()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_porcelain_v2, GitChangeState};

    #[test]
    fn parses_branch_and_staged_worktree_statuses() {
        let raw = [
            b"# branch.oid abc123\0".as_slice(),
            b"# branch.head main\0".as_slice(),
            b"# branch.ab +2 -1\0".as_slice(),
            b"1 MM N... 100644 100644 100644 abc abc src/main.rs\0".as_slice(),
            b"? new file.txt\0".as_slice(),
        ]
        .concat();
        let status = parse_porcelain_v2(&raw, "");

        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].path, "new file.txt");
        assert!(status.changes[0].untracked);
        assert_eq!(status.changes[1].index, GitChangeState::Modified);
        assert_eq!(status.changes[1].worktree, GitChangeState::Modified);
    }

    #[test]
    fn filters_changes_outside_nested_workspace() {
        let raw = [
            b"1 .M N... 100644 100644 100644 abc abc packages/app/src/App.tsx\0".as_slice(),
            b"1 .M N... 100644 100644 100644 abc abc packages/other/src/Other.tsx\0".as_slice(),
        ]
        .concat();
        let status = parse_porcelain_v2(&raw, "packages/app");

        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, "src/App.tsx");
    }
}
