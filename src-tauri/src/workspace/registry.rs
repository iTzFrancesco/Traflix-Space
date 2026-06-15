use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct GridLayout {
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    _app: AppHandle,
}

impl WorkspaceRegistry {
    pub fn new(app: AppHandle) -> Self {
        Self {
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            _app: app,
        }
    }
}
