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
    #[serde(default)]
    pub jarvis: JarvisSettings,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub voice_engine: VoiceEngine,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub wake_word_enabled: bool,
    #[serde(default)]
    pub widget_position: WidgetPosition,
    #[serde(default)]
    pub standard_pipeline: StandardPipelineSettings,
    #[serde(default)]
    pub gemini_live: GeminiLiveSettings,
    #[serde(default)]
    pub model_provider: ModelProvider,
    #[serde(default = "default_longcat_model")]
    pub model: String,
    #[serde(default = "default_true")]
    pub fallback_to_deepseek: bool,
    #[serde(default)]
    pub privacy_consent: bool,
    #[serde(default)]
    pub privacy_consent_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    LongCat,
    DeepSeek,
}

impl Default for ModelProvider {
    fn default() -> Self {
        Self::LongCat
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEngine {
    Standard,
    GeminiLive,
}

impl Default for VoiceEngine {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    /// Normalized widget center, independent of the exact window dimensions.
    #[serde(default = "default_widget_x")]
    pub x: f32,
    #[serde(default = "default_widget_y")]
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardPipelineSettings {
    #[serde(default = "default_standard_stt")]
    pub stt: String,
    #[serde(default)]
    pub fast_model: String,
    #[serde(default)]
    pub context_planner: String,
    #[serde(default = "default_standard_tts")]
    pub tts: String,
    #[serde(default)]
    pub voice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiLiveSettings {
    #[serde(default = "default_gemini_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default = "default_true")]
    pub automatic_turn_detection: bool,
    #[serde(default = "default_true")]
    pub allow_interruption: bool,
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
            jarvis: JarvisSettings::default(),
        }
    }
}

impl Default for JarvisSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            voice_engine: VoiceEngine::Standard,
            muted: false,
            wake_word_enabled: false,
            widget_position: WidgetPosition::default(),
            standard_pipeline: StandardPipelineSettings::default(),
            gemini_live: GeminiLiveSettings::default(),
            model_provider: ModelProvider::default(),
            model: default_longcat_model(),
            fallback_to_deepseek: true,
            privacy_consent: false,
            privacy_consent_at: None,
        }
    }
}

impl Default for WidgetPosition {
    fn default() -> Self {
        Self {
            x: default_widget_x(),
            y: default_widget_y(),
        }
    }
}

impl Default for StandardPipelineSettings {
    fn default() -> Self {
        Self {
            stt: default_standard_stt(),
            fast_model: String::new(),
            context_planner: String::new(),
            tts: default_standard_tts(),
            voice: String::new(),
        }
    }
}

impl Default for GeminiLiveSettings {
    fn default() -> Self {
        Self {
            provider: default_gemini_provider(),
            model: String::new(),
            voice: String::new(),
            automatic_turn_detection: true,
            allow_interruption: true,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_widget_x() -> f32 {
    0.5
}

fn default_widget_y() -> f32 {
    0.9
}

fn default_standard_stt() -> String {
    "Traflix Voice / Whisper-compatible".to_string()
}

fn default_standard_tts() -> String {
    "Edge TTS-compatible".to_string()
}

fn default_gemini_provider() -> String {
    "Gemini Live".to_string()
}

fn default_longcat_model() -> String {
    "LongCat-2.0".to_string()
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

#[cfg(test)]
mod tests {
    use super::{AppSettings, VoiceEngine};

    #[test]
    fn legacy_settings_keep_existing_values_and_get_jarvis_defaults() {
        let legacy = r##"{
            "sidebar": {
                "isCollapsed": true,
                "workspaceOrder": ["workspace-a"],
                "activeWorkspaceId": "workspace-a"
            },
            "theme": { "accentColor": "#123456" }
        }"##;

        let settings: AppSettings = serde_json::from_str(legacy).unwrap();

        assert!(settings.sidebar.is_collapsed);
        assert_eq!(
            settings.sidebar.workspace_order,
            vec!["workspace-a".to_string()]
        );
        assert_eq!(
            settings.sidebar.active_workspace_id.as_deref(),
            Some("workspace-a")
        );
        assert_eq!(settings.theme.accent_color, "#123456");
        assert!(settings.jarvis.enabled);
        assert_eq!(settings.jarvis.voice_engine, VoiceEngine::Standard);
        assert_eq!(settings.jarvis.widget_position.x, 0.5);
        assert_eq!(settings.jarvis.widget_position.y, 0.9);
    }
}
