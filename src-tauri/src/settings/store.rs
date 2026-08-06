use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

use serde::{Deserialize, Deserializer, Serialize};
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

#[derive(Debug, Clone, Serialize)]
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
    pub text_model: TextModelSettings,
    #[serde(default)]
    pub advanced_view_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextModelSettings {
    #[serde(default)]
    pub provider: ModelProvider,
    #[serde(default = "default_primary_model")]
    pub primary_model: String,
    #[serde(default = "default_fallback_model")]
    pub fallback_model: String,
    #[serde(default = "default_true")]
    pub fallback_enabled: bool,
    #[serde(default)]
    pub privacy_consent: bool,
    #[serde(default)]
    pub privacy_consent_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    OpenCodeZen,
}

impl Default for ModelProvider {
    fn default() -> Self {
        Self::OpenCodeZen
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

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyJarvisSettings {
    enabled: Option<bool>,
    voice_engine: Option<VoiceEngine>,
    muted: Option<bool>,
    wake_word_enabled: Option<bool>,
    widget_position: Option<WidgetPosition>,
    standard_pipeline: Option<StandardPipelineSettings>,
    gemini_live: Option<GeminiLiveSettings>,
    text_model: Option<TextModelSettings>,
    advanced_view_enabled: Option<bool>,
    // These fields were part of the first text-provider slice. They are read
    // only to migrate values; they are never serialized again.
    model_provider: Option<String>,
    model: Option<String>,
    fallback_to_deepseek: Option<bool>,
    privacy_consent: Option<bool>,
    privacy_consent_at: Option<String>,
}

impl<'de> Deserialize<'de> for JarvisSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = LegacyJarvisSettings::deserialize(deserializer)?;
        let has_new_text_model = raw.text_model.is_some();
        let mut text_model = raw.text_model.clone().unwrap_or_default();
        if !has_new_text_model {
            if let Some(model) = raw.model.filter(|value| !value.trim().is_empty()) {
                text_model.primary_model = model;
            }
            if let Some(enabled) = raw.fallback_to_deepseek {
                text_model.fallback_enabled = enabled;
            }
            if let Some(consent) = raw.privacy_consent {
                text_model.privacy_consent = consent;
            }
            text_model.privacy_consent_at = raw.privacy_consent_at;
            // The legacy provider selector is intentionally not mapped to a
            // second runtime provider. All text traffic now uses OpenCode Zen.
            let _ = raw.model_provider;
        }
        if !text_model.privacy_consent {
            text_model.privacy_consent_at = None;
        }
        Ok(Self {
            enabled: raw.enabled.unwrap_or_else(default_true),
            voice_engine: raw.voice_engine.unwrap_or_default(),
            muted: raw.muted.unwrap_or(false),
            wake_word_enabled: raw.wake_word_enabled.unwrap_or(false),
            widget_position: raw.widget_position.unwrap_or_default(),
            standard_pipeline: raw.standard_pipeline.unwrap_or_default(),
            gemini_live: raw.gemini_live.unwrap_or_default(),
            text_model,
            advanced_view_enabled: raw.advanced_view_enabled.unwrap_or(false),
        })
    }
}

impl Default for TextModelSettings {
    fn default() -> Self {
        Self {
            provider: ModelProvider::OpenCodeZen,
            primary_model: default_primary_model(),
            fallback_model: default_fallback_model(),
            fallback_enabled: true,
            privacy_consent: false,
            privacy_consent_at: None,
        }
    }
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
            text_model: TextModelSettings::default(),
            advanced_view_enabled: false,
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
fn default_primary_model() -> String {
    "longcat-2.0-free".to_string()
}
fn default_fallback_model() -> String {
    "deepseek-v4-flash-free".to_string()
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
        serde_json::from_str(&data).ok()
    }

    fn save_to_disk(path: &str, settings: &AppSettings) -> Result<(), String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                error!(error = %e, "Errore creazione directory settings");
                format!("Errore creazione directory: {}", e)
            })?;
        }
        let data = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Errore serializzazione: {}", e))?;
        std::fs::write(path, data).map_err(|e| format!("Errore scrittura settings: {}", e))
    }

    pub async fn get(&self) -> AppSettings {
        self.settings.lock().await.clone()
    }

    pub async fn set(&self, mut settings: AppSettings) -> Result<(), String> {
        if !settings.jarvis.text_model.privacy_consent {
            settings.jarvis.text_model.privacy_consent_at = None;
        }
        *self.settings.lock().await = settings.clone();
        Self::save_to_disk(&self.store_path, &settings)
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, ModelProvider, VoiceEngine};

    #[test]
    fn legacy_settings_migrate_to_open_code_zen_defaults() {
        let legacy = r##"{
            "sidebar": { "isCollapsed": true, "workspaceOrder": ["workspace-a"], "activeWorkspaceId": "workspace-a" },
            "theme": { "accentColor": "#123456" },
            "jarvis": { "modelProvider": "long_cat", "model": "legacy-model", "fallbackToDeepseek": true, "privacyConsent": true, "privacyConsentAt": "2026-08-07T00:00:00Z" }
        }"##;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            settings.jarvis.text_model.provider,
            ModelProvider::OpenCodeZen
        );
        assert_eq!(settings.jarvis.text_model.primary_model, "legacy-model");
        assert!(settings.jarvis.text_model.fallback_enabled);
        assert!(settings.jarvis.text_model.privacy_consent);
        assert!(!settings.jarvis.advanced_view_enabled);
        assert_eq!(settings.jarvis.voice_engine, VoiceEngine::Standard);
    }

    #[test]
    fn new_defaults_are_safe_and_consent_is_false() {
        let settings = AppSettings::default();
        assert_eq!(
            settings.jarvis.text_model.provider,
            ModelProvider::OpenCodeZen
        );
        assert_eq!(settings.jarvis.text_model.primary_model, "longcat-2.0-free");
        assert_eq!(
            settings.jarvis.text_model.fallback_model,
            "deepseek-v4-flash-free"
        );
        assert!(!settings.jarvis.text_model.privacy_consent);
        assert!(!settings.jarvis.advanced_view_enabled);
    }
}
