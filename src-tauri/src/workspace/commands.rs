use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tracing::{error, info, warn};

use super::registry::{WorkspaceConfig, WorkspaceRegistry};

/// Normalizza un path Windows rimuovendo il prefisso `\\?\` (e `\\.\`)
/// che `std::fs::canonicalize` aggiunge automaticamente.
fn normalize_windows_path(p: &str) -> String {
    let p = p.trim_start_matches("\\\\?\\");
    let p = p.trim_start_matches("\\\\.\\");
    // `\\?\C:\...` dopo lo strip diventa `C:\...`, già corretto
    p.to_string()
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
    // Normalizza tutti i path rimuovendo eventuale prefisso \\\?\ di Windows
    config.root_path = normalize_windows_path(&config.root_path);
    for term in &mut config.terminals {
        term.cwd = normalize_windows_path(&term.cwd);
    }

    info!(name = %config.name, path = %config.root_path, "Creazione workspace");

    let registry = app.state::<WorkspaceRegistry>();

    // Save local .traflix/workspace.json
    let root = Path::new(&config.root_path);
    let traflix_dir = root.join(".traflix");
    std::fs::create_dir_all(&traflix_dir)
        .map_err(|e| {
            error!(%config.name, error = %e, "Errore creazione .traflix");
            format!("Errore creazione .traflix: {}", e)
        })?;

    let local_config = serde_json::to_string_pretty(&config)
        .map_err(|e| {
            error!(%config.name, error = %e, "Errore serializzazione config");
            format!("Errore serializzazione: {}", e)
        })?;
    std::fs::write(traflix_dir.join("workspace.json"), &local_config)
        .map_err(|e| {
            error!(%config.name, error = %e, "Errore scrittura workspace.json");
            format!("Errore scrittura workspace.json: {}", e)
        })?;

    // Save to global registry
    registry.insert(config.clone()).await;
    registry.save().await?;

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
    registry
        .get(&id)
        .await
        .ok_or_else(|| {
            warn!(%id, "Workspace non trovato");
            "Workspace non trovato".into()
        })
}

#[tauri::command]
pub async fn update_workspace(
    app: AppHandle,
    id: String,
    mut config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    if id != config.id {
        warn!(%id, new_id = %config.id, "ID mismatch nell'update workspace");
        return Err("ID mismatch: url param differs from body".into());
    }

    // Normalizza tutti i path rimuovendo eventuale prefisso \\\?\ di Windows
    config.root_path = normalize_windows_path(&config.root_path);
    for term in &mut config.terminals {
        term.cwd = normalize_windows_path(&term.cwd);
    }

    info!(%id, name = %config.name, "Aggiornamento workspace");
    let registry = app.state::<WorkspaceRegistry>();

    // Update local .traflix/workspace.json
    let root = Path::new(&config.root_path);
    let local_config = serde_json::to_string_pretty(&config)
        .map_err(|e| {
            error!(%id, error = %e, "Errore serializzazione update");
            format!("Errore serializzazione: {}", e)
        })?;
    std::fs::write(root.join(".traflix").join("workspace.json"), &local_config)
        .map_err(|e| {
            error!(%id, error = %e, "Errore update workspace.json");
            format!("Errore scrittura workspace.json: {}", e)
        })?;

    // Update global registry
    registry.insert(config.clone()).await;
    registry.save().await?;

    info!(%id, "Workspace aggiornato");
    Ok(config)
}

#[tauri::command]
pub async fn delete_workspace(app: AppHandle, id: String) -> Result<(), String> {
    info!(%id, "Eliminazione workspace");
    let registry = app.state::<WorkspaceRegistry>();
    registry.remove(&id).await;
    registry.save().await?;
    info!(%id, "Workspace eliminato");
    Ok(())
}

#[tauri::command]
pub async fn get_default_workspace_path() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Impossibile ottenere la home directory".to_string())?;
    let default = PathBuf::from(&home)
        .join("OneDrive")
        .join("Documenti")
        .join("developer")
        .join("GitHub");
    Ok(default.to_string_lossy().to_string())
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
        // Se il target contiene ":" (es. "C:") o inizia con "\\" è un path assoluto
        t if t.contains(":\\") || t.starts_with("\\") => PathBuf::from(t),
        t if t.starts_with("~/") || t.starts_with("~\\") => {
            let rel = &t[2..];
            PathBuf::from(&home).join(rel)
        }
        t => base_path.join(t),
    };

    // Canonicalizza il path
    let canonical = std::fs::canonicalize(&resolved).map_err(|e| {
        format!("Percorso non trovato: {} ({})", resolved.display(), e)
    })?;

    let canonical_str = normalize_windows_path(&canonical.to_string_lossy());

    // Leggi il contenuto della directory
    let mut children: Vec<String> = Vec::new();
    if canonical.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&canonical) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Nascondi file/nascosti
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

    // Anche il parent va normalizzato (viene da canonical)
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

    let file = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Dialog timeout: il dialog non ha risposto entro 10 secondi".to_string())?
        .map_err(|_| "Dialog cancelled".to_string())?;
    match file {
        Some(path) => {
            let raw = path.to_string();
            let normalized = normalize_windows_path(&raw);
            info!(path = %normalized, "Cartella selezionata");
            Ok(normalized)
        }
        None => {
            warn!("Nessuna cartella selezionata");
            Err("Nessuna cartella selezionata".into())
        }
    }
}
