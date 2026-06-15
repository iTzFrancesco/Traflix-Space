use std::path::Path;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use super::registry::{WorkspaceConfig, WorkspaceRegistry};

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();

    // Save local .traflix/workspace.json
    let root = Path::new(&config.root_path);
    let traflix_dir = root.join(".traflix");
    std::fs::create_dir_all(&traflix_dir)
        .map_err(|e| format!("Errore creazione .traflix: {}", e))?;

    let local_config = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Errore serializzazione: {}", e))?;
    std::fs::write(traflix_dir.join("workspace.json"), &local_config)
        .map_err(|e| format!("Errore scrittura workspace.json: {}", e))?;

    // Save to global registry
    registry.insert(config.clone()).await;
    registry.save().await?;

    Ok(config)
}

#[tauri::command]
pub async fn get_workspaces(
    app: AppHandle,
) -> Result<Vec<WorkspaceConfig>, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    Ok(registry.get_all().await)
}

#[tauri::command]
pub async fn get_workspace(
    app: AppHandle,
    id: String,
) -> Result<WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.load().await?;
    registry.get(&id).await.ok_or_else(|| "Workspace non trovato".into())
}

#[tauri::command]
pub async fn update_workspace(
    app: AppHandle,
    id: String,
    config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    let registry = app.state::<WorkspaceRegistry>();

    // Update local .traflix/workspace.json
    let root = Path::new(&config.root_path);
    let local_config = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Errore serializzazione: {}", e))?;
    std::fs::write(root.join(".traflix").join("workspace.json"), &local_config)
        .map_err(|e| format!("Errore scrittura workspace.json: {}", e))?;

    // Update global registry
    registry.insert(config.clone()).await;
    registry.save().await?;

    Ok(config)
}

#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let registry = app.state::<WorkspaceRegistry>();
    registry.remove(&id).await;
    registry.save().await?;
    Ok(())
}

#[tauri::command]
pub async fn select_folder(
    app: AppHandle,
) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();

    app.dialog()
        .file()
        .set_title("Seleziona cartella workspace")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let file = rx.await.map_err(|_| "Dialog cancelled".to_string())?;
    match file {
        Some(path) => Ok(path.to_string()),
        None => Err("Nessuna cartella selezionata".into()),
    }
}
