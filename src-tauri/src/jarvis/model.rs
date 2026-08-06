use crate::settings::store::{JarvisSettings, ModelProvider as SettingsModelProvider};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ModelToolCall>>,
}

impl ModelMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_call_id: None,
            tool_calls: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ModelFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelToolDefinition {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ModelFunctionDefinition,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct ModelResponse {
    pub content: String,
    pub tool_calls: Vec<ModelToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    ConsentRequired,
    NotConfigured,
    Unavailable,
    InvalidResponse,
}

#[derive(Clone)]
pub struct ModelProvider {
    client: Client,
}

impl Default for ModelProvider {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(75))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }
}

impl ModelProvider {
    pub fn configured(provider: SettingsModelProvider) -> bool {
        credential(provider).is_some()
    }

    pub async fn complete(
        &self,
        settings: &JarvisSettings,
        messages: &[ModelMessage],
        tools: &[ModelToolDefinition],
    ) -> Result<(ModelResponse, SettingsModelProvider, bool), ModelError> {
        if !settings.privacy_consent {
            return Err(ModelError::ConsentRequired);
        }

        let primary = settings.model_provider;
        let fallback =
            if settings.fallback_to_deepseek && primary != SettingsModelProvider::DeepSeek {
                Some(SettingsModelProvider::DeepSeek)
            } else {
                None
            };
        let primary_result = if Self::configured(primary) {
            self.request(
                primary,
                &configured_model(primary, &settings.model),
                messages,
                tools,
            )
            .await
        } else {
            Err(ModelError::NotConfigured)
        };
        match primary_result {
            Ok(response) => Ok((response, primary, false)),
            Err(primary_error) => {
                let Some(fallback) = fallback else {
                    return Err(primary_error);
                };
                if !Self::configured(fallback) {
                    return Err(primary_error);
                }
                self.request(fallback, &configured_model(fallback, ""), messages, tools)
                    .await
                    .map(|response| (response, fallback, true))
            }
        }
    }

    async fn request(
        &self,
        provider: SettingsModelProvider,
        model: &str,
        messages: &[ModelMessage],
        tools: &[ModelToolDefinition],
    ) -> Result<ModelResponse, ModelError> {
        let Some(api_key) = credential(provider) else {
            return Err(ModelError::NotConfigured);
        };
        let request = ChatRequest {
            model: model.to_string(),
            messages: messages.to_vec(),
            tools: (!tools.is_empty()).then(|| tools.to_vec()),
            max_tokens: 1400,
            temperature: 0.2,
        };
        let response = self
            .client
            .post(endpoint(provider))
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .await
            .map_err(|_| ModelError::Unavailable)?;
        if !response.status().is_success() {
            // Never forward the provider response: it can contain request
            // metadata, echoed prompts, or accidental credential material.
            return Err(ModelError::Unavailable);
        }
        let payload = response
            .json::<ChatResponse>()
            .await
            .map_err(|_| ModelError::InvalidResponse)?;
        let choice = payload
            .choices
            .into_iter()
            .next()
            .ok_or(ModelError::InvalidResponse)?;
        Ok(ModelResponse {
            content: choice.message.content.unwrap_or_default(),
            tool_calls: choice.message.tool_calls.unwrap_or_default(),
        })
    }
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ModelMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ModelToolDefinition>>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
    tool_calls: Option<Vec<ModelToolCall>>,
}

pub fn provider_label(provider: SettingsModelProvider) -> &'static str {
    match provider {
        SettingsModelProvider::LongCat => "longcat",
        SettingsModelProvider::DeepSeek => "deepseek",
    }
}

pub fn model_name(provider: SettingsModelProvider) -> &'static str {
    match provider {
        SettingsModelProvider::LongCat => "LongCat-2.0",
        SettingsModelProvider::DeepSeek => "deepseek-chat",
    }
}

pub fn configured_model(provider: SettingsModelProvider, configured: &str) -> String {
    if !configured.trim().is_empty() {
        return configured.to_string();
    }
    model_name(provider).to_string()
}

fn endpoint(provider: SettingsModelProvider) -> &'static str {
    match provider {
        SettingsModelProvider::LongCat => "https://api.longcat.chat/openai/v1/chat/completions",
        SettingsModelProvider::DeepSeek => "https://api.deepseek.com/chat/completions",
    }
}

fn credential(provider: SettingsModelProvider) -> Option<String> {
    let name = match provider {
        SettingsModelProvider::LongCat => "TRAFLIX_LONGCAT_API_KEY",
        SettingsModelProvider::DeepSeek => "TRAFLIX_DEEPSEEK_API_KEY",
    };
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::{configured_model, provider_label};
    use crate::settings::store::ModelProvider as SettingsModelProvider;

    #[test]
    fn provider_defaults_never_expose_credentials() {
        assert_eq!(provider_label(SettingsModelProvider::LongCat), "longcat");
        assert_eq!(
            configured_model(SettingsModelProvider::DeepSeek, ""),
            "deepseek-chat"
        );
    }
}
