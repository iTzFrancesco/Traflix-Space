use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub sidebar: SidebarSettings,
    pub theme: ThemeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettings {
    pub is_collapsed: bool,
    pub workspace_order: Vec<String>,
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub accent_color: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sidebar: SidebarSettings {
                is_collapsed: false,
                workspace_order: vec![],
                active_workspace_id: None,
            },
            theme: ThemeSettings {
                accent_color: "#e85d04".into(),
            },
        }
    }
}

pub struct SettingsManager {
    settings: Arc<Mutex<AppSettings>>,
    store_path: String,
}

impl SettingsManager {
    pub fn new(app: &AppHandle) -> Self {
        let store_path = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join("traflix-space")
            .join("settings.json")
            .to_string_lossy()
            .to_string();

        let settings = Self::load_from_disk(&store_path).unwrap_or_default();

        info!(path = %store_path, "Settings caricati");

        Self {
            settings: Arc::new(Mutex::new(settings)),
            store_path,
        }
    }

    fn load_from_disk(path: &str) -> Option<AppSettings> {
        let data = std::fs::read_to_string(path).ok()?;
        let settings: AppSettings = serde_json::from_str(&data).ok()?;
        Some(settings)
    }

    fn save_to_disk(path: &str, settings: &AppSettings) -> Result<(), String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                error!(error = %e, "Errore creazione directory settings");
                format!("Errore creazione directory: {}", e)
            })?;
        }
        let data = serde_json::to_string_pretty(settings).map_err(|e| {
            error!(error = %e, "Errore serializzazione settings");
            format!("Errore serializzazione: {}", e)
        })?;
        std::fs::write(path, data).map_err(|e| {
            error!(error = %e, "Errore scrittura settings su disco");
            format!("Errore scrittura settings: {}", e)
        })?;
        Ok(())
    }

    pub async fn get(&self) -> AppSettings {
        self.settings.lock().await.clone()
    }

    pub async fn set(&self, settings: AppSettings) -> Result<(), String> {
        *self.settings.lock().await = settings.clone();
        Self::save_to_disk(&self.store_path, &settings)
    }
}
