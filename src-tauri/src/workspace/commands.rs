use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tracing::{info, warn};

use super::registry::{WorkspaceConfig, WorkspaceRegistry};
use crate::terminal_engine::TerminalManager;

/// Normalizza un path Windows rimuovendo il prefisso `\\?\` (e `\\.\`)
/// che `std::fs::canonicalize` aggiunge automaticamente.
fn normalize_windows_path(p: &str) -> String {
    let p = p.trim_start_matches("\\\\?\\");
    let p = p.trim_start_matches("\\\\.\\");
    p.to_string()
}

fn canonical_directory(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} non specificata", label));
    }
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|error| format!("{} non trovata: {} ({})", label, trimmed, error))?;
    if !canonical.is_dir() {
        return Err(format!("{} non è una cartella: {}", label, trimmed));
    }
    Ok(canonical)
}

/// Normalize a newly created workspace before it reaches the persistent
/// registry. This keeps broken paths out of workspaces.json and binds each
/// configured terminal to the workspace it belongs to.
fn validate_new_workspace(config: &mut WorkspaceConfig) -> Result<(), String> {
    if config.id.trim().is_empty() {
        return Err("ID workspace non valido".to_string());
    }
    if config.name.trim().is_empty() {
        return Err("Nome workspace non valido".to_string());
    }
    if config.terminals.is_empty() || config.terminals.len() > 8 {
        return Err("Una workspace deve contenere da 1 a 8 terminali".to_string());
    }

    let root = canonical_directory(&config.root_path, "Cartella workspace")?;
    config.root_path = normalize_windows_path(&root.to_string_lossy());

    for terminal in &mut config.terminals {
        if terminal.id.trim().is_empty() {
            return Err("ID terminale non valido".to_string());
        }
        let cwd = if terminal.cwd.trim().is_empty() {
            root.clone()
        } else {
            canonical_directory(&terminal.cwd, "Cartella terminale")?
        };
        terminal.cwd = normalize_windows_path(&cwd.to_string_lossy());
        terminal.workspace_id = Some(config.id.clone());
    }
    Ok(())
}

fn preferred_default_workspace_path(home: &Path) -> PathBuf {
    let preferred = home
        .join("OneDrive")
        .join("Documenti")
        .join("developer")
        .join("GitHub");
    if preferred.is_dir() {
        return preferred;
    }
    if home.is_dir() {
        return home.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNavResult {
    pub path: String,
    pub exists: bool,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    mut config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    validate_new_workspace(&mut config)?;

    info!(name = %config.name, path = %config.root_path, "Creazione workspace");

    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;

    // Workspace metadata belongs exclusively to the app-data registry, never
    // to the user's project directory.
    registry.insert_and_save(config.clone()).await?;
    app.state::<TerminalManager>()
        .allow_workspace_spawns(&config.id);

    info!(name = %config.name, "Workspace creato con successo");
    Ok(config)
}

#[tauri::command]
pub async fn get_workspaces(app: AppHandle) -> Result<Vec<WorkspaceConfig>, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    let workspaces = registry.get_all().await;
    info!(count = workspaces.len(), "Caricati workspace");
    Ok(workspaces)
}

#[tauri::command]
pub async fn get_workspace(app: AppHandle, id: String) -> Result<WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    registry.get(&id).await.ok_or_else(|| {
        warn!(%id, "Workspace non trovato");
        "Workspace non trovato".into()
    })
}

#[tauri::command]
pub async fn update_workspace(
    app: AppHandle,
    id: String,
    mut config: WorkspaceConfig,
    expected_updated_at: String,
) -> Result<WorkspaceConfig, String> {
    if id != config.id {
        warn!(%id, new_id = %config.id, "ID mismatch nell'update workspace");
        return Err("ID mismatch: url param differs from body".into());
    }

    // Updates must remain possible even if a project folder was removed while
    // Traflix Space was open (for example, to close stale terminals). Normalize
    // persisted paths without imposing create-time existence checks.
    config.root_path = normalize_windows_path(&config.root_path);
    for term in &mut config.terminals {
        term.cwd = normalize_windows_path(&term.cwd);
        term.workspace_id = Some(config.id.clone());
    }

    info!(%id, name = %config.name, "Aggiornamento workspace");
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;

    // Keep the project directory untouched; update only the app-data registry.
    let updated = registry
        .replace_and_save_if_updated_at(&id, &expected_updated_at, config.clone())
        .await?;

    info!(%id, "Workspace aggiornato");
    Ok(updated)
}

/// Persist a user-requested terminal title so Jarvis can use the same
/// read-only semantic hint that the visible title bar shows.
#[tauri::command]
pub async fn update_terminal_title(
    app: AppHandle,
    workspace_id: String,
    terminal_id: String,
    title: String,
) -> Result<WorkspaceConfig, String> {
    let title = title.trim();
    if title.is_empty() || title.len() > 200 || title.chars().any(char::is_control) {
        return Err("Titolo terminale non valido".to_string());
    }
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    let workspace = registry
        .update_terminal_title_and_save(&workspace_id, &terminal_id, title)
        .await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn delete_workspace(app: AppHandle, id: String) -> Result<(), String> {
    info!(%id, "Eliminazione workspace");
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    registry
        .get(&id)
        .await
        .ok_or_else(|| "Workspace non trovato".to_string())?;
    let manager = app.state::<TerminalManager>();
    // The runtime gate rejects every new spawn before sessions are selected.
    // Keeping the definition visible until the atomic registry transaction
    // commits makes a persistence failure recoverable without reconstructing
    // a potentially concurrently changed workspace.
    if let Err(error) = manager.shutdown_workspace(&app, &id).await {
        manager.allow_workspace_spawns(&id);
        return Err(error);
    }
    if let Err(error) = registry.remove_workspace_and_save(&id).await {
        manager.allow_workspace_spawns(&id);
        return Err(error);
    }
    info!(%id, "Workspace eliminato");
    Ok(())
}

#[tauri::command]
pub async fn get_default_workspace_path() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let default = preferred_default_workspace_path(&home);
    Ok(normalize_windows_path(&default.to_string_lossy()))
}

#[tauri::command]
pub async fn navigate_folder(
    current_path: Option<String>,
    input: String,
) -> Result<FolderNavResult, String> {
    let trimmed = input.trim();

    // Supporta sia "cd percorso" sia direttamente il percorso
    let target = if let Some(rest) = trimmed.strip_prefix("cd ") {
        rest.trim()
    } else {
        trimmed
    };

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".to_string());

    let base = current_path.unwrap_or_else(|| home.clone());
    let base_path = PathBuf::from(&base);

    let resolved = match target {
        "~" | "~\\" | "~/" => PathBuf::from(&home),
        ".." => base_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(&home)),
        "." => base_path.clone(),
        // Se il target contiene ":" (es. "C:\") o inizia con "\\" è un path assoluto
        t if t.contains(":\\") || t.starts_with("\\") => PathBuf::from(t),
        t if t.starts_with("~/") || t.starts_with("~\\") => {
            let rel = &t[2..];
            PathBuf::from(&home).join(rel)
        }
        t => base_path.join(t),
    };

    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|e| format!("Percorso non trovato: {} ({})", resolved.display(), e))?;

    let canonical_str = normalize_windows_path(&canonical.to_string_lossy());

    let mut children: Vec<String> = Vec::new();
    if canonical.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&canonical) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        children.push(format!("{}/", name));
                    } else {
                        children.push(name);
                    }
                }
            }
        }
        children.sort();
    }

    let parent = canonical
        .parent()
        .map(|p| normalize_windows_path(&p.to_string_lossy()));

    Ok(FolderNavResult {
        path: canonical_str,
        exists: true,
        parent,
        children,
    })
}

#[tauri::command]
pub async fn select_folder(app: AppHandle) -> Result<String, String> {
    info!("Apertura dialog selezione cartella");
    let (tx, rx) = oneshot::channel();

    app.dialog()
        .file()
        .set_title("Seleziona cartella workspace")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    // A folder picker is a human interaction, not a network request. Do not
    // expire it after an arbitrary ten seconds while the user is browsing.
    let file = rx
        .await
        .map_err(|_| "Il selettore cartelle è stato chiuso in modo inatteso".to_string())?;
    match file {
        Some(path) => {
            let raw = path.to_string();
            let canonical = canonical_directory(&raw, "Cartella selezionata")?;
            let normalized = normalize_windows_path(&canonical.to_string_lossy());
            info!(path = %normalized, "Cartella selezionata");
            Ok(normalized)
        }
        None => {
            info!("Selezione cartella annullata");
            Err("folder-selection-cancelled".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::preferred_default_workspace_path;
    use std::path::Path;

    #[test]
    fn default_workspace_path_always_returns_an_existing_directory_candidate() {
        let current = std::env::current_dir().unwrap();
        let selected = preferred_default_workspace_path(Path::new(&current));
        assert!(selected.is_dir());
    }
}
