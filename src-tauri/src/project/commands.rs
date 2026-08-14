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
const MAX_IMAGE_PREVIEW_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePreview {
    workspace_id: String,
    path: String,
    kind: String,
    mime_type: Option<String>,
    content: String,
    content_base64: Option<String>,
    binary: bool,
    truncated: bool,
    redacted: bool,
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
    registry.load().await?;
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
    registry.load().await?;
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
    registry.load().await?;
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

    tauri::async_runtime::spawn_blocking(move || read_file_preview(workspace_id, root_path, path))
        .await
        .map_err(|error| format!("Errore durante la lettura del file: {error}"))?
}

async fn workspace_from_registry(
    app: &AppHandle,
    workspace_id: &str,
) -> Result<crate::workspace::registry::WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
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
    // Environment files are never eligible for image/Base64 previews. A
    // file such as ".env.png" must remain redacted even when its bytes match
    // a valid image signature.
    let environment_file = is_environment_file(&relative_path);
    let image_extension = (!environment_file)
        .then(|| image_extension(&file_path))
        .flatten();
    let read_limit = if image_extension.is_some() {
        MAX_IMAGE_PREVIEW_BYTES
    } else {
        MAX_FILE_PREVIEW_BYTES
    };
    let mut bytes = Vec::with_capacity(read_limit + 1);
    file.by_ref()
        .take((read_limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossibile leggere il file: {error}"))?;
    let truncated = bytes.len() > read_limit;
    if truncated {
        bytes.truncate(read_limit);
    }

    if let Some(extension) = image_extension {
        if let Some(mime_type) = image_mime_type(&extension, &bytes) {
            return Ok(ProjectFilePreview {
                workspace_id,
                path: relative_path,
                kind: if truncated { "binary" } else { "image" }.to_string(),
                mime_type: (!truncated).then_some(mime_type.to_string()),
                content: String::new(),
                content_base64: (!truncated).then(|| encode_base64(&bytes)),
                binary: true,
                truncated,
                redacted: false,
                size,
            });
        }
    }

    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let mut redacted = environment_file;
    let content = if binary {
        String::new()
    } else {
        let text = String::from_utf8(bytes).unwrap_or_default();
        if environment_file {
            redacted = true;
            redact_environment_preview(&text)
        } else {
            text
        }
    };

    Ok(ProjectFilePreview {
        workspace_id,
        path: relative_path,
        kind: if binary { "binary" } else { "text" }.to_string(),
        mime_type: if binary {
            None
        } else {
            Some("text/plain".to_string())
        },
        content,
        content_base64: None,
        binary,
        truncated,
        redacted,
        size,
    })
}

fn is_environment_file(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .any(|part| part == ".env" || part.starts_with(".env."))
}

fn redact_environment_preview(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || (trimmed.starts_with('#') && !line.contains('=')) {
                return line.to_string();
            }
            line.find('=').map_or_else(
                || "<REDACTED>".to_string(),
                |separator| format!("{}<REDACTED>", &line[..=separator]),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn image_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" => Some(extension),
        _ => None,
    }
}

fn image_mime_type(extension: &str, bytes: &[u8]) -> Option<&'static str> {
    let valid = match extension {
        "png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF8"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "bmp" => bytes.starts_with(b"BM"),
        "ico" => bytes.starts_with(&[0, 0, 1, 0]),
        _ => false,
    };
    if !valid {
        return None;
    }
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => unreachable!(),
    })
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().saturating_add(2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as usize;
        let second = chunk.get(1).copied().unwrap_or_default() as usize;
        let third = chunk.get(2).copied().unwrap_or_default() as usize;
        output.push(ALPHABET[first >> 2] as char);
        output.push(ALPHABET[((first & 0x03) << 4) | (second >> 4)] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((second & 0x0f) << 2) | (third >> 6)] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[third & 0x3f] as char
        } else {
            '='
        });
    }
    output
}

#[tauri::command]
pub async fn project_watch_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
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
        assert_eq!(preview.kind, "text");
        assert!(preview.content_base64.is_none());
        assert!(!preview.binary);
        assert!(!preview.truncated);
        assert!(!preview.redacted);
        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn environment_preview_keeps_structure_but_redacts_values() {
        let file_name = format!(".env.preview-{}", std::process::id());
        let file_path = std::env::temp_dir().join(&file_name);
        let _ = std::fs::remove_file(&file_path);
        std::fs::write(
            &file_path,
            "# local settings\n# GROQ_API_KEY=comment-secret\nGROQ_API_KEY=synthetic-secret\nEMPTY=\n",
        )
        .expect("write environment preview fixture");

        let preview = read_file_preview(
            "workspace".to_string(),
            std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir"),
            file_name,
        )
        .expect("read environment preview fixture");

        assert!(preview.redacted);
        assert!(preview.content.contains("# local settings"));
        assert!(preview.content.contains("# GROQ_API_KEY=<REDACTED>"));
        assert!(preview.content.contains("GROQ_API_KEY=<REDACTED>"));
        assert!(preview.content.contains("EMPTY=<REDACTED>"));
        assert!(!preview.content.contains("comment-secret"));
        assert!(!preview.content.contains("synthetic-secret"));
        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn environment_image_preview_never_exposes_base64() {
        let file_name = format!(".env.preview-{}.png", std::process::id());
        let file_path = std::env::temp_dir().join(&file_name);
        let _ = std::fs::remove_file(&file_path);
        std::fs::write(&file_path, [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
            .expect("write environment image fixture");

        let preview = read_file_preview(
            "workspace".to_string(),
            std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir"),
            file_name,
        )
        .expect("read environment image preview fixture");

        assert!(preview.redacted);
        assert!(preview.content_base64.is_none());
        assert!(preview.binary);
        assert_eq!(preview.kind, "binary");
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
