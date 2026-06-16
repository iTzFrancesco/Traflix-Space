use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub layout: GridLayout,
    pub terminals: Vec<TerminalConfig>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    pub id: String,
    pub shell: String,
    pub agent_id: Option<String>,
    pub command: Option<String>,
    pub cwd: String,
    pub title: String,
}

pub struct WorkspaceRegistry {
    workspaces: Arc<Mutex<HashMap<String, WorkspaceConfig>>>,
    registry_path: PathBuf,
    loaded: Arc<std::sync::atomic::AtomicBool>,
    _app: AppHandle,
}

impl WorkspaceRegistry {
    pub fn new(app: AppHandle) -> Self {
        let registry_path = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("traflix-space")
            .join("workspaces.json");

        let workspaces = Arc::new(Mutex::new(HashMap::new()));

        Self {
            workspaces,
            registry_path,
            loaded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            _app: app,
        }
    }

    pub async fn load(&self) -> Result<(), String> {
        if self.loaded.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        if !self.registry_path.exists() {
            self.loaded.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(());
        }
        let data = std::fs::read_to_string(&self.registry_path)
            .map_err(|e| format!("Errore lettura registry: {}", e))?;
        let list: Vec<WorkspaceConfig> =
            serde_json::from_str(&data).map_err(|e| format!("Errore parsing registry: {}", e))?;
        let mut map = self.workspaces.lock().await;
        map.clear();
        for ws in list {
            map.insert(ws.id.clone(), ws);
        }
        self.loaded.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub async fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.registry_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Errore creazione directory: {}", e))?;
        }
        let map = self.workspaces.lock().await;
        let list: Vec<&WorkspaceConfig> = map.values().collect();
        let data = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("Errore serializzazione: {}", e))?;
        std::fs::write(&self.registry_path, data)
            .map_err(|e| format!("Errore scrittura registry: {}", e))?;
        Ok(())
    }

    pub async fn insert(&self, config: WorkspaceConfig) {
        let mut map = self.workspaces.lock().await;
        map.insert(config.id.clone(), config);
    }

    pub async fn get_all(&self) -> Vec<WorkspaceConfig> {
        let map = self.workspaces.lock().await;
        map.values().cloned().collect()
    }

    pub async fn get(&self, id: &str) -> Option<WorkspaceConfig> {
        let map = self.workspaces.lock().await;
        map.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.workspaces.lock().await;
        map.remove(id);
    }
}
