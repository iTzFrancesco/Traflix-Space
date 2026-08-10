use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::AppHandle;
use tauri::Manager;

const OWNER_MODE_MARKER: &str = "owner-mode";

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
    pub codex: CodexModelSettings,
    #[serde(default)]
    pub advanced_view_enabled: bool,
    #[serde(default)]
    pub voice_input: VoiceInputSettings,
    #[serde(default)]
    pub voice_output: VoiceOutputSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_groq_provider")]
    pub provider: String,
    #[serde(default = "default_groq_model")]
    pub model: String,
    #[serde(default = "default_voice_language")]
    pub language: String,
    #[serde(default = "default_voice_max_duration")]
    pub max_duration_seconds: u32,
    #[serde(default)]
    pub selected_input_device_id: Option<String>,
    #[serde(default)]
    pub auto_submit_transcript: bool,
    #[serde(default)]
    pub privacy_consent: bool,
    #[serde(default)]
    pub privacy_consent_at: Option<String>,
    #[serde(default)]
    pub activation_mode: VoiceActivationMode,
    #[serde(default)]
    pub global_shortcut_enabled: bool,
    #[serde(default = "default_global_shortcut")]
    pub global_shortcut: String,
    #[serde(default)]
    pub shortcut_behavior: ShortcutBehavior,
    #[serde(default)]
    pub vad_enabled: bool,
    #[serde(default = "default_vad_threshold")]
    pub vad_speech_threshold: f32,
    #[serde(default = "default_vad_start_frames")]
    pub vad_start_frames: u16,
    #[serde(default = "default_vad_silence_frames")]
    pub vad_silence_frames: u16,
    #[serde(default = "default_vad_preroll_ms")]
    pub vad_pre_roll_ms: u32,
    #[serde(default = "default_vad_post_speech_ms")]
    pub vad_post_speech_ms: u32,
    #[serde(default = "default_max_armed_seconds")]
    pub max_armed_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOutputSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_edge_provider")]
    pub provider: String,
    #[serde(default = "default_edge_voice")]
    pub voice: String,
    #[serde(default = "default_edge_rate")]
    pub rate: String,
    #[serde(default = "default_edge_volume")]
    pub volume: String,
    #[serde(default = "default_edge_pitch")]
    pub pitch: String,
    #[serde(default = "default_true")]
    pub auto_speak: bool,
    #[serde(default = "default_max_spoken_chars")]
    pub max_spoken_chars: usize,
    #[serde(default)]
    pub privacy_consent: bool,
    #[serde(default)]
    pub privacy_consent_at: Option<String>,
    #[serde(default = "default_true")]
    pub stop_on_user_speech: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceActivationMode {
    // Retained for backwards-compatible deserialization. Owner-mode migration
    // normalizes this legacy push-to-toggle policy to hands-free VAD.
    ClickToggle,
    HoldToTalk,
    Vad,
}

impl Default for VoiceActivationMode {
    fn default() -> Self {
        Self::Vad
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutBehavior {
    Toggle,
    Hold,
}

impl Default for ShortcutBehavior {
    fn default() -> Self {
        Self::Toggle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextModelSettings {
    #[serde(default)]
    pub provider: ModelProvider,
    #[serde(default = "default_primary_model")]
    pub primary_model: String,
    #[serde(default)]
    pub fallback_model: String,
    #[serde(default)]
    pub fallback_enabled: bool,
    #[serde(default)]
    pub privacy_consent: bool,
    #[serde(default)]
    pub privacy_consent_at: Option<String>,
}

/// C3 — Codex model selection persisted in settings. The default matches
/// the spec: GPT-5.6 Luna with Low reasoning effort.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelSettings {
    #[serde(default = "default_codex_model")]
    pub model: String,
    #[serde(default = "default_codex_reasoning")]
    pub reasoning_effort: String,
    /// C8: speak completed commentary items progressively (Edge TTS queue).
    #[serde(default = "default_true")]
    pub speak_commentary: bool,
}

impl Default for CodexModelSettings {
    fn default() -> Self {
        Self {
            model: default_codex_model(),
            reasoning_effort: default_codex_reasoning(),
            speak_commentary: default_true(),
        }
    }
}

fn default_codex_model() -> String {
    "gpt-5.6-luna".to_string()
}

fn default_codex_reasoning() -> String {
    "low".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    /// C10: the Codex App Server is the single Jarvis LLM provider; legacy
    /// persisted `open_code_zen` values migrate transparently to it.
    #[serde(alias = "open_code_zen")]
    Codex,
}

impl Default for ModelProvider {
    fn default() -> Self {
        Self::Codex
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
    codex: Option<CodexModelSettings>,
    advanced_view_enabled: Option<bool>,
    voice_input: Option<VoiceInputSettings>,
    voice_output: Option<VoiceOutputSettings>,
    // These fields were part of the first text-provider slice. They are read
    // only to migrate values; they are never serialized again.
    model: Option<String>,
    privacy_consent: Option<bool>,
    privacy_consent_at: Option<String>,
}

fn enforce_owner_mode(settings: &mut JarvisSettings) {
    settings.text_model.privacy_consent = true;
    if settings.text_model.privacy_consent_at.is_none() {
        settings.text_model.privacy_consent_at = Some(OWNER_MODE_MARKER.to_string());
    }

    settings.voice_input.enabled = true;
    settings.voice_input.auto_submit_transcript = true;
    if settings.voice_input.activation_mode == VoiceActivationMode::ClickToggle {
        settings.voice_input.activation_mode = VoiceActivationMode::Vad;
    }
    settings.voice_input.vad_enabled =
        settings.voice_input.activation_mode != VoiceActivationMode::HoldToTalk;
    settings.voice_input.privacy_consent = true;
    if settings.voice_input.privacy_consent_at.is_none() {
        settings.voice_input.privacy_consent_at = Some(OWNER_MODE_MARKER.to_string());
    }

    settings.voice_output.enabled = true;
    settings.voice_output.auto_speak = true;
    settings.voice_output.stop_on_user_speech = true;
    settings.voice_output.privacy_consent = true;
    if settings.voice_output.privacy_consent_at.is_none() {
        settings.voice_output.privacy_consent_at = Some(OWNER_MODE_MARKER.to_string());
    }
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
                text_model.primary_model = migrate_legacy_primary_model(&model);
            }
            if let Some(consent) = raw.privacy_consent {
                text_model.privacy_consent = consent;
            }
            text_model.privacy_consent_at = raw.privacy_consent_at;
            // The legacy provider selector is intentionally not mapped to a
            // second runtime provider. All text traffic now uses OpenCode Zen
            // with a single preferred model; no fallback is configured.
        }
        let mut settings = Self {
            enabled: raw.enabled.unwrap_or_else(default_true),
            voice_engine: raw.voice_engine.unwrap_or_default(),
            muted: raw.muted.unwrap_or(false),
            wake_word_enabled: raw.wake_word_enabled.unwrap_or(false),
            widget_position: raw.widget_position.unwrap_or_default(),
            standard_pipeline: raw.standard_pipeline.unwrap_or_default(),
            gemini_live: raw.gemini_live.unwrap_or_default(),
            text_model,
            codex: raw.codex.unwrap_or_default(),
            advanced_view_enabled: raw.advanced_view_enabled.unwrap_or(false),
            voice_input: raw.voice_input.unwrap_or_default(),
            voice_output: raw.voice_output.unwrap_or_default(),
        };
        enforce_owner_mode(&mut settings);
        Ok(settings)
    }
}

impl Default for TextModelSettings {
    fn default() -> Self {
        Self {
            provider: ModelProvider::Codex,
            primary_model: default_primary_model(),
            // No fallback: all text traffic uses the single preferred model.
            fallback_model: String::new(),
            fallback_enabled: false,
            privacy_consent: true,
            privacy_consent_at: Some(OWNER_MODE_MARKER.to_string()),
        }
    }
}

impl Default for VoiceInputSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: default_groq_provider(),
            model: default_groq_model(),
            language: default_voice_language(),
            max_duration_seconds: default_voice_max_duration(),
            selected_input_device_id: None,
            auto_submit_transcript: true,
            privacy_consent: true,
            privacy_consent_at: Some(OWNER_MODE_MARKER.to_string()),
            activation_mode: VoiceActivationMode::Vad,
            global_shortcut_enabled: false,
            global_shortcut: default_global_shortcut(),
            shortcut_behavior: ShortcutBehavior::default(),
            vad_enabled: true,
            vad_speech_threshold: default_vad_threshold(),
            vad_start_frames: default_vad_start_frames(),
            vad_silence_frames: default_vad_silence_frames(),
            vad_pre_roll_ms: default_vad_preroll_ms(),
            vad_post_speech_ms: default_vad_post_speech_ms(),
            max_armed_seconds: default_max_armed_seconds(),
        }
    }
}

impl Default for VoiceOutputSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: default_edge_provider(),
            voice: default_edge_voice(),
            rate: default_edge_rate(),
            volume: default_edge_volume(),
            pitch: default_edge_pitch(),
            auto_speak: true,
            max_spoken_chars: default_max_spoken_chars(),
            privacy_consent: true,
            privacy_consent_at: Some(OWNER_MODE_MARKER.to_string()),
            stop_on_user_speech: true,
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
            codex: CodexModelSettings::default(),
            advanced_view_enabled: false,
            voice_input: VoiceInputSettings::default(),
            voice_output: VoiceOutputSettings::default(),
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
    "gpt-5.6-luna".to_string()
}
fn default_groq_provider() -> String {
    "groq".to_string()
}
fn default_groq_model() -> String {
    "whisper-large-v3-turbo".to_string()
}
fn default_voice_language() -> String {
    "it".to_string()
}
fn default_voice_max_duration() -> u32 {
    45
}
fn default_global_shortcut() -> String {
    "Ctrl+Alt+Space".to_string()
}
fn default_vad_threshold() -> f32 {
    0.018
}
fn default_vad_start_frames() -> u16 {
    3
}
fn default_vad_silence_frames() -> u16 {
    16
}
fn default_vad_preroll_ms() -> u32 {
    250
}
fn default_vad_post_speech_ms() -> u32 {
    650
}
fn default_max_armed_seconds() -> u32 {
    120
}
fn default_edge_provider() -> String {
    "edge_tts".to_string()
}
fn default_edge_voice() -> String {
    "it-IT-DiegoNeural".to_string()
}
fn default_edge_rate() -> String {
    "+0%".to_string()
}
fn default_edge_volume() -> String {
    "+0%".to_string()
}
fn default_edge_pitch() -> String {
    "+0Hz".to_string()
}
fn default_max_spoken_chars() -> usize {
    800
}

fn migrate_legacy_primary_model(model: &str) -> String {
    if is_legacy_longcat_model(model) || is_legacy_deepseek_model(model) {
        default_primary_model()
    } else {
        model.to_string()
    }
}

fn is_legacy_longcat_model(model: &str) -> bool {
    matches!(
        model.trim().to_ascii_lowercase().as_str(),
        "longcat" | "longcat-2.0" | "longcat-2.0-free"
    )
}

fn is_legacy_deepseek_model(model: &str) -> bool {
    matches!(
        model.trim().to_ascii_lowercase().as_str(),
        "deepseek"
            | "deepseek-chat"
            | "deepseek-coder"
            | "deepseek-reasoner"
            | "deepseek-v3"
            | "deepseek-v3.1"
            | "deepseek-v4"
            | "deepseek-v4-flash"
            | "deepseek-v4-flash-free"
    )
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
        enforce_owner_mode(&mut settings.jarvis);
        *self.settings.lock().await = settings.clone();
        Self::save_to_disk(&self.store_path, &settings)
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, ModelProvider, ShortcutBehavior, VoiceActivationMode, VoiceEngine};

    #[test]
    fn legacy_settings_migrate_to_codex_defaults() {
        let legacy = r##"{
            "sidebar": { "isCollapsed": true, "workspaceOrder": ["workspace-a"], "activeWorkspaceId": "workspace-a" },
            "theme": { "accentColor": "#123456" },
            "jarvis": { "modelProvider": "long_cat", "model": "legacy-model", "fallbackToDeepseek": true, "privacyConsent": true, "privacyConsentAt": "2026-08-07T00:00:00Z" }
        }"##;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            settings.jarvis.text_model.provider,
            ModelProvider::Codex
        );
        assert_eq!(settings.jarvis.text_model.primary_model, "legacy-model");
        assert!(!settings.jarvis.text_model.fallback_enabled);
        assert!(settings.jarvis.text_model.fallback_model.is_empty());
        assert!(settings.jarvis.text_model.privacy_consent);
        assert!(!settings.jarvis.advanced_view_enabled);
        assert_eq!(settings.jarvis.voice_input.model, "whisper-large-v3-turbo");
        assert!(settings.jarvis.voice_input.auto_submit_transcript);
        assert!(settings.jarvis.voice_input.vad_enabled);
        assert_eq!(
            settings.jarvis.voice_input.activation_mode,
            VoiceActivationMode::Vad
        );
        assert_eq!(settings.jarvis.voice_input.max_armed_seconds, 120);
        assert_eq!(settings.jarvis.voice_output.provider, "edge_tts");
        assert!(settings.jarvis.voice_output.privacy_consent);
        assert_eq!(settings.jarvis.voice_engine, VoiceEngine::Standard);
    }

    #[test]
    fn f513485_longcat_aliases_migrate_to_the_codex_primary() {
        for legacy_model in ["LongCat-2.0", "LongCat", "longcat"] {
            let legacy = format!(
                r##"{{
                    "sidebar": {{ "isCollapsed": false, "workspaceOrder": [], "activeWorkspaceId": null }},
                    "theme": {{ "accentColor": "#123456" }},
                    "jarvis": {{ "modelProvider": "long_cat", "model": "{legacy_model}", "fallbackToDeepseek": true }}
                }}"##
            );
            let settings: AppSettings = serde_json::from_str(&legacy).unwrap();
            // C10: the legacy Zen gateway is gone; legacy model ids now
            // resolve to the Codex default model.
            assert_eq!(
                settings.jarvis.text_model.primary_model,
                "gpt-5.6-luna"
            );
            assert!(!settings.jarvis.text_model.fallback_enabled);
            assert!(settings.jarvis.text_model.fallback_model.is_empty());
        }
    }

    #[test]
    fn f513485_direct_deepseek_models_migrate_to_the_codex_primary() {
        let legacy = r##"{
            "sidebar": { "isCollapsed": false, "workspaceOrder": [], "activeWorkspaceId": null },
            "theme": { "accentColor": "#123456" },
            "jarvis": { "modelProvider": "deepseek", "model": "deepseek-chat", "fallbackToDeepseek": true }
        }"##;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            settings.jarvis.text_model.primary_model,
            "gpt-5.6-luna"
        );
        assert!(!settings.jarvis.text_model.fallback_enabled);
        assert!(settings.jarvis.text_model.fallback_model.is_empty());
    }

    #[test]
    fn custom_legacy_model_is_preserved_during_migration() {
        let legacy = r##"{
            "sidebar": { "isCollapsed": false, "workspaceOrder": [], "activeWorkspaceId": null },
            "theme": { "accentColor": "#123456" },
            "jarvis": { "modelProvider": "long_cat", "model": "my-private-model", "fallbackToDeepseek": true }
        }"##;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(settings.jarvis.text_model.primary_model, "my-private-model");
    }

    #[test]
    fn custom_deepseek_model_is_not_rewritten() {
        let legacy = r##"{
            "sidebar": { "isCollapsed": false, "workspaceOrder": [], "activeWorkspaceId": null },
            "theme": { "accentColor": "#123456" },
            "jarvis": { "modelProvider": "long_cat", "model": "deepseek-enterprise-custom", "fallbackToDeepseek": true }
        }"##;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            settings.jarvis.text_model.primary_model,
            "deepseek-enterprise-custom"
        );
    }

    #[test]
    fn serialized_new_text_model_preserves_explicit_deepseek_primary() {
        let mut original = AppSettings::default();
        original.jarvis.text_model.primary_model = "deepseek-v4-flash-free".to_string();

        let serialized = serde_json::to_string(&original).unwrap();
        let reloaded: AppSettings = serde_json::from_str(&serialized).unwrap();

        assert_eq!(
            reloaded.jarvis.text_model.primary_model,
            "deepseek-v4-flash-free"
        );
    }

    #[test]
    fn serialized_custom_text_model_is_not_rewritten_by_default_migration() {
        let mut original = AppSettings::default();
        original.jarvis.text_model.primary_model = "my-custom-primary".to_string();
        original.jarvis.text_model.fallback_model = "my-custom-fallback".to_string();

        let serialized = serde_json::to_string(&original).unwrap();
        let reloaded: AppSettings = serde_json::from_str(&serialized).unwrap();

        assert_eq!(
            reloaded.jarvis.text_model.primary_model,
            "my-custom-primary"
        );
        assert_eq!(
            reloaded.jarvis.text_model.fallback_model,
            "my-custom-fallback"
        );
    }

    #[test]
    fn new_defaults_are_owner_mode_safe() {
        let settings = AppSettings::default();
        assert_eq!(
            settings.jarvis.text_model.provider,
            ModelProvider::Codex
        );
        assert_eq!(
            settings.jarvis.text_model.primary_model,
            "gpt-5.6-luna"
        );
        assert!(settings.jarvis.text_model.fallback_model.is_empty());
        assert!(!settings.jarvis.text_model.fallback_enabled);
        assert!(settings.jarvis.text_model.privacy_consent);
        assert!(settings.jarvis.text_model.privacy_consent_at.is_some());
        assert!(settings.jarvis.voice_input.enabled);
        assert!(settings.jarvis.voice_input.auto_submit_transcript);
        assert!(settings.jarvis.voice_input.vad_enabled);
        assert!(settings.jarvis.voice_input.privacy_consent);
        assert_eq!(
            settings.jarvis.voice_input.activation_mode,
            VoiceActivationMode::Vad
        );
        assert_eq!(settings.jarvis.voice_input.max_armed_seconds, 120);
        assert!(settings.jarvis.voice_output.enabled);
        assert!(settings.jarvis.voice_output.auto_speak);
        assert!(settings.jarvis.voice_output.stop_on_user_speech);
        assert!(settings.jarvis.voice_output.privacy_consent);
        assert!(!settings.jarvis.advanced_view_enabled);
    }

    #[test]
    fn owner_mode_migrates_click_toggle_but_preserves_hold_to_talk() {
        let mut click_settings = AppSettings::default();
        click_settings.jarvis.voice_input.activation_mode = VoiceActivationMode::ClickToggle;
        let click_reloaded: AppSettings =
            serde_json::from_str(&serde_json::to_string(&click_settings).unwrap()).unwrap();
        assert_eq!(
            click_reloaded.jarvis.voice_input.activation_mode,
            VoiceActivationMode::Vad
        );

        let mut settings = AppSettings::default();
        settings.jarvis.voice_input.activation_mode = VoiceActivationMode::HoldToTalk;
        settings.jarvis.voice_input.auto_submit_transcript = false;
        settings.jarvis.voice_input.vad_enabled = true;
        settings.jarvis.voice_input.privacy_consent = false;
        settings.jarvis.voice_input.privacy_consent_at = None;
        settings.jarvis.voice_input.global_shortcut_enabled = true;
        settings.jarvis.voice_input.global_shortcut = "Ctrl+Shift+Space".into();
        settings.jarvis.voice_input.shortcut_behavior = ShortcutBehavior::Hold;
        settings.jarvis.voice_input.vad_speech_threshold = 0.031;
        settings.jarvis.voice_output.stop_on_user_speech = false;
        settings.jarvis.voice_output.privacy_consent = false;
        settings.jarvis.voice_output.privacy_consent_at = None;
        let reloaded: AppSettings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            reloaded.jarvis.voice_input.activation_mode,
            VoiceActivationMode::HoldToTalk
        );
        assert!(reloaded.jarvis.voice_input.auto_submit_transcript);
        assert!(!reloaded.jarvis.voice_input.vad_enabled);
        assert!(reloaded.jarvis.voice_input.privacy_consent);
        assert!(reloaded.jarvis.voice_output.stop_on_user_speech);
        assert!(reloaded.jarvis.voice_output.privacy_consent);
        assert!(reloaded.jarvis.voice_input.global_shortcut_enabled);
        assert_eq!(
            reloaded.jarvis.voice_input.global_shortcut,
            "Ctrl+Shift+Space"
        );
        assert_eq!(
            reloaded.jarvis.voice_input.shortcut_behavior,
            ShortcutBehavior::Hold
        );
        assert_eq!(reloaded.jarvis.voice_input.vad_speech_threshold, 0.031);
    }
}
