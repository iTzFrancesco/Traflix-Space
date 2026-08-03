use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::workspace::registry::WorkspaceRegistry;

use super::git::{self, ProjectGitDiff, ProjectGitStatus};
use super::watcher::ProjectWatcherRegistry;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryResponse {
    workspace_id: String,
    relative_path: String,
    entries: Vec<ProjectEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    name: String,
    path: String,
    kind: ProjectEntryKind,
}

const MAX_FILE_PREVIEW_BYTES: usize = 128 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePreview {
    workspace_id: String,
    path: String,
    content: String,
    binary: bool,
    truncated: bool,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectEntryKind {
    File,
    Directory,
}

#[tauri::command]
pub async fn project_list_directory(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<ProjectDirectoryResponse, String> {
    let registry = app.state::<WorkspaceRegistry>();
    let workspace = registry
        .get(&workspace_id)
        .await
        .ok_or_else(|| format!("Workspace non trovata: {workspace_id}"))?;

    let root_path = workspace.root_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_directory(workspace_id, root_path, relative_path)
    })
    .await
    .map_err(|error| format!("Errore durante la lettura della directory: {error}"))?
}

#[tauri::command]
pub async fn project_git_status(
    app: AppHandle,
    workspace_id: String,
) -> Result<ProjectGitStatus, String> {
    let registry = app.state::<WorkspaceRegistry>();
    let workspace = registry
        .get(&workspace_id)
        .await
        .ok_or_else(|| format!("Workspace non trovata: {workspace_id}"))?;
    let root_path = std::fs::canonicalize(&workspace.root_path)
        .map_err(|error| format!("Impossibile accedere alla workspace: {error}"))?;

    git::status_for_workspace(workspace_id, root_path).await
}

#[tauri::command]
pub async fn project_git_diff(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
    side: String,
) -> Result<ProjectGitDiff, String> {
    let registry = app.state::<WorkspaceRegistry>();
    let workspace = registry
        .get(&workspace_id)
        .await
        .ok_or_else(|| format!("Workspace non trovata: {workspace_id}"))?;
    let root_path = std::fs::canonicalize(&workspace.root_path)
        .map_err(|error| format!("Impossibile accedere alla workspace: {error}"))?;

    git::diff_for_workspace(workspace_id, root_path, relative_path, side).await
}

#[tauri::command]
pub async fn project_git_stage(
    app: AppHandle,
    workspace_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    git::stage_for_workspace(root_path, paths).await
}

#[tauri::command]
pub async fn project_git_unstage(
    app: AppHandle,
    workspace_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    git::unstage_for_workspace(root_path, paths).await
}

#[tauri::command]
pub async fn project_git_discard(
    app: AppHandle,
    workspace_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    git::discard_for_workspace(root_path, paths).await
}

#[tauri::command]
pub async fn project_git_commit(
    app: AppHandle,
    workspace_id: String,
    message: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    git::commit_for_workspace(root_path, message, paths).await
}

#[tauri::command]
pub async fn project_git_sync(
    app: AppHandle,
    workspace_id: String,
    action: String,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    git::sync_for_workspace(root_path, action).await
}

#[tauri::command]
#[allow(deprecated)]
pub async fn project_open_file(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<(), String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    let file_path = resolve_workspace_file(&root_path, &relative_path)?;
    app.shell()
        .open(file_path.to_string_lossy().to_string(), None)
        .map_err(|error| format!("Impossibile aprire il file: {error}"))
}

#[tauri::command]
pub async fn project_read_file(
    app: AppHandle,
    workspace_id: String,
    relative_path: String,
) -> Result<ProjectFilePreview, String> {
    let workspace = workspace_from_registry(&app, &workspace_id).await?;
    let root_path = canonical_workspace_root(&workspace.root_path)?;
    let path = relative_path.replace('\\', "/");
    if path
        .split('/')
        .any(|part| part == ".env" || part.starts_with(".env."))
    {
        return Err("L’anteprima dei file di ambiente è disabilitata".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || read_file_preview(workspace_id, root_path, path))
        .await
        .map_err(|error| format!("Errore durante la lettura del file: {error}"))?
}

async fn workspace_from_registry(
    app: &AppHandle,
    workspace_id: &str,
) -> Result<crate::workspace::registry::WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry
        .get(workspace_id)
        .await
        .ok_or_else(|| format!("Workspace non trovata: {workspace_id}"))
}

fn canonical_workspace_root(root_path: &str) -> Result<std::path::PathBuf, String> {
    std::fs::canonicalize(root_path)
        .map_err(|error| format!("Impossibile accedere alla workspace: {error}"))
}

fn resolve_workspace_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = relative_path.replace('/', "\\");
    let relative = Path::new(&relative);
    let mut candidate = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => candidate.push(part),
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("Il percorso deve restare nella workspace".to_string());
            }
        }
    }
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("File non accessibile: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Il file deve restare nella workspace".to_string());
    }
    if !canonical.is_file() {
        return Err("Il percorso selezionato non è un file".to_string());
    }
    Ok(canonical)
}

fn read_file_preview(
    workspace_id: String,
    root: PathBuf,
    relative_path: String,
) -> Result<ProjectFilePreview, String> {
    let file_path = resolve_workspace_file(&root, &relative_path)?;
    let size = std::fs::metadata(&file_path)
        .map_err(|error| format!("Impossibile leggere i metadati del file: {error}"))?
        .len();
    let mut file = std::fs::File::open(&file_path)
        .map_err(|error| format!("Impossibile leggere il file: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_FILE_PREVIEW_BYTES + 1);
    file.by_ref()
        .take((MAX_FILE_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossibile leggere il file: {error}"))?;
    let truncated = bytes.len() > MAX_FILE_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_FILE_PREVIEW_BYTES);
    }
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let content = if binary {
        String::new()
    } else {
        String::from_utf8(bytes).unwrap_or_default()
    };

    Ok(ProjectFilePreview {
        workspace_id,
        path: relative_path,
        content,
        binary,
        truncated,
        size,
    })
}

#[tauri::command]
pub async fn project_watch_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let registry = app.state::<WorkspaceRegistry>();
    let workspace = registry
        .get(&workspace_id)
        .await
        .ok_or_else(|| format!("Workspace non trovata: {workspace_id}"))?;
    let root_path = std::fs::canonicalize(&workspace.root_path)
        .map_err(|error| format!("Impossibile accedere alla workspace: {error}"))?;
    let additional_roots = git::repository_root_for_workspace(&root_path)
        .await
        .into_iter()
        .collect();
    let watcher_registry = app.state::<ProjectWatcherRegistry>();
    watcher_registry.watch(app.clone(), workspace_id, root_path, additional_roots)
}

#[tauri::command]
pub async fn project_unwatch_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let watcher_registry = app.state::<ProjectWatcherRegistry>();
    watcher_registry.unwatch(&workspace_id)
}

fn list_directory(
    workspace_id: String,
    root_path: String,
    relative_path: String,
) -> Result<ProjectDirectoryResponse, String> {
    let root = std::fs::canonicalize(root_path)
        .map_err(|error| format!("Impossibile accedere alla workspace: {error}"))?;
    let directory = resolve_directory(&root, &relative_path)?;

    let mut entries = Vec::new();
    for item in std::fs::read_dir(&directory)
        .map_err(|error| format!("Impossibile leggere la directory: {error}"))?
    {
        let item = item.map_err(|error| format!("Impossibile leggere una voce: {error}"))?;
        let item_path = item.path();
        let file_type = item
            .file_type()
            .map_err(|error| format!("Impossibile leggere il tipo di una voce: {error}"))?;
        let relative_item = item_path
            .strip_prefix(&root)
            .map_err(|_| "La voce è fuori dalla workspace".to_string())?;

        entries.push(ProjectEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: to_frontend_path(relative_item),
            kind: if file_type.is_dir() {
                ProjectEntryKind::Directory
            } else {
                ProjectEntryKind::File
            },
        });
    }

    entries.sort_by(|left, right| {
        let left_directory = matches!(&left.kind, ProjectEntryKind::Directory);
        let right_directory = matches!(&right.kind, ProjectEntryKind::Directory);

        right_directory
            .cmp(&left_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(ProjectDirectoryResponse {
        workspace_id,
        relative_path: to_frontend_path(
            directory
                .strip_prefix(&root)
                .map_err(|_| "La directory è fuori dalla workspace".to_string())?,
        ),
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::read_file_preview;

    #[test]
    fn reads_text_file_preview() {
        let file_name = format!("traflix-space-preview-{}.txt", std::process::id());
        let file_path = std::env::temp_dir().join(&file_name);
        let _ = std::fs::remove_file(&file_path);
        std::fs::write(&file_path, "alpha\nbeta\n").expect("write preview fixture");

        let preview = read_file_preview(
            "workspace".to_string(),
            std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir"),
            file_name,
        )
        .expect("read preview fixture");

        assert_eq!(preview.content, "alpha\nbeta\n");
        assert!(!preview.binary);
        assert!(!preview.truncated);
        let _ = std::fs::remove_file(file_path);
    }
}

fn resolve_directory(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = relative_path.replace('/', "\\");
    let relative = Path::new(&relative);
    let mut candidate = root.to_path_buf();

    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => candidate.push(part),
            Component::ParentDir => {
                if !candidate.pop() || !candidate.starts_with(root) {
                    return Err("Percorso directory non valido".to_string());
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("Il percorso deve restare nella workspace".to_string());
            }
        }
    }

    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("Directory non accessibile: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Il percorso deve restare nella workspace".to_string());
    }
    if !canonical.is_dir() {
        return Err("Il percorso selezionato non è una directory".to_string());
    }

    Ok(canonical)
}

fn to_frontend_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value == "." {
        String::new()
    } else {
        value
    }
}
