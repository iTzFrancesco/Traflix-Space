use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub sidebar: SidebarSettings,
    pub theme: ThemeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarSettings {
    pub is_collapsed: bool,
    pub workspace_order: Vec<String>,
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
