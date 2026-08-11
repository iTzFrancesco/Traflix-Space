//! C3 — Model settings: `model/list`, `account/rateLimits/read`,
//! `account/usage/read`.
//!
//! Selectors are populated from the App Server catalog, never hardcoded.
//! Rate-limit updates (`account/rateLimits/updated`) are *incremental*:
//! [`merge_rate_limit_snapshot`] merges them into the last full snapshot
//! and never overwrites missing fields with `null` (spec §7, user
//! correction #5).

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tracing::debug;

use super::rpc::JsonRpcClient;
use super::runtime::{CodexRuntimeManager, RuntimeError};

/// Global Tauri event with the merged rate-limit snapshot.
pub const RATE_LIMITS_EVENT: &str = "jarvis://codex-rate-limits";

/// A single reasoning effort option, order preserved from the server
/// catalog (user correction #5: never reorder client-side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningEffort {
    pub reasoning_effort: String,
    pub description: Option<String>,
}

/// One catalog entry from `model/list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    pub is_default: bool,
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<CodexReasoningEffort>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCatalog {
    pub data: Vec<CodexModelInfo>,
}

/// Token usage view (summary only — the raw buckets are heavy and not
/// needed by the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageView {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
}

/// Full rate-limit snapshot view (token-free, safe for the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitsView {
    /// Raw merged snapshot. Kept as JSON because the protocol schema is
    /// nested and evolving; the UI reads known fields defensively.
    pub snapshot: Value,
}

/// Merges an incremental `rateLimits` update into the previous snapshot.
///
/// Rules (user correction #5):
/// - every field present in `update` overwrites the snapshot;
/// - a field present with `null` is *ignored* (never erases data);
/// - when there is no previous snapshot, the update becomes the snapshot.
pub fn merge_rate_limit_snapshot(previous: Option<&Value>, update: &Value) -> Value {
    fn merge_into(target: &mut Value, update: &Value) {
        let (Some(target_obj), Some(update_obj)) = (target.as_object_mut(), update.as_object())
        else {
            // Non-objects (or null) never overwrite a snapshot.
            return;
        };
        for (key, value) in update_obj {
            if value.is_null() {
                continue;
            }
            match target_obj.get_mut(key) {
                Some(existing) if existing.is_object() && value.is_object() => {
                    merge_into(existing, value);
                }
                _ => {
                    target_obj.insert(key.clone(), value.clone());
                }
            }
        }
    }

    match previous {
        Some(prev) => {
            let mut merged = prev.clone();
            merge_into(&mut merged, update);
            merged
        }
        None => update.clone(),
    }
}

/// Parses a `model/list` result into the catalog view (server order).
pub(crate) fn parse_catalog(result: &Value) -> CodexModelCatalog {
    let mut catalog = CodexModelCatalog { data: Vec::new() };
    if let Some(data) = result.get("data").and_then(Value::as_array) {
        for entry in data {
            let supported = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .map(|efforts| {
                    efforts
                        .iter()
                        .filter_map(|effort| {
                            let reasoning_effort =
                                effort.get("reasoningEffort")?.as_str()?.to_owned();
                            Some(CodexReasoningEffort {
                                reasoning_effort,
                                description: effort
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            catalog.data.push(CodexModelInfo {
                id: entry
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                display_name: entry
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: entry
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                supported_reasoning_efforts: supported,
            });
        }
    }
    catalog
}

/// Shared service behind the C3 Tauri commands + rate-limit event bridge.
#[derive(Clone)]
pub struct CodexModelService {
    runtime: CodexRuntimeManager,
    /// Last full snapshot merged from `rateLimits/read` + incremental
    /// `account/rateLimits/updated` notifications.
    rate_limit_snapshot: Arc<Mutex<Option<Value>>>,
}

impl CodexModelService {
    pub fn new(runtime: CodexRuntimeManager) -> Self {
        Self {
            runtime,
            rate_limit_snapshot: Arc::new(Mutex::new(None)),
        }
    }

    async fn client(&self) -> Result<Arc<JsonRpcClient>, RuntimeError> {
        self.runtime.client().await
    }

    /// `model/list` — full catalog, server order.
    pub async fn list_models(&self) -> Result<CodexModelCatalog, RuntimeError> {
        let client = self.client().await?;
        let result = client.request("model/list", json!({})).await?;
        Ok(parse_catalog(&result))
    }

    /// `account/rateLimits/read` — full snapshot, cached + merged.
    pub async fn rate_limits(&self) -> Result<CodexRateLimitsView, RuntimeError> {
        let client = self.client().await?;
        let result = client.request("account/rateLimits/read", json!({})).await?;
        self.store_snapshot(result.clone());
        Ok(CodexRateLimitsView { snapshot: result })
    }

    /// Applies an incremental `account/rateLimits/updated` notification.
    /// Emits the merged snapshot on `jarvis://codex-rate-limits`.
    pub fn apply_incremental_update(&self, app: &AppHandle, update: &Value) {
        let snapshot = {
            let mut guard = self.rate_limit_snapshot.lock().expect("rate limit mutex");
            let merged = merge_rate_limit_snapshot(guard.as_ref(), update);
            *guard = Some(merged.clone());
            merged
        };
        debug!("codex rate limits merged incrementally");
        let _ = app.emit(RATE_LIMITS_EVENT, snapshot);
    }

    /// Last merged snapshot, if any.
    #[allow(dead_code)]
    pub fn snapshot(&self) -> Option<Value> {
        self.rate_limit_snapshot
            .lock()
            .expect("rate limit mutex")
            .clone()
    }

    fn store_snapshot(&self, snapshot: Value) {
        *self.rate_limit_snapshot.lock().expect("rate limit mutex") = Some(snapshot);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jarvis_codex_model_list(
    models: tauri::State<'_, CodexModelService>,
) -> Result<CodexModelCatalog, String> {
    models
        .list_models()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_rate_limits(
    models: tauri::State<'_, CodexModelService>,
) -> Result<CodexRateLimitsView, String> {
    models
        .rate_limits()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))
}

#[tauri::command]
pub async fn jarvis_codex_usage(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexUsageView, String> {
    let client = runtime
        .client()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))?;
    let result = client
        .request("account/usage/read", json!({}))
        .await
        .map_err(|err| format!("codex_rpc_failed: {err}"))?;
    let summary = result.get("summary").cloned().unwrap_or(json!({}));
    Ok(CodexUsageView {
        lifetime_tokens: summary.get("lifetimeTokens").and_then(Value::as_u64),
        peak_daily_tokens: summary.get("peakDailyTokens").and_then(Value::as_u64),
        current_streak_days: summary.get("currentStreakDays").and_then(Value::as_u64),
        longest_streak_days: summary.get("longestStreakDays").and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_keeps_missing_fields_and_drops_nulls() {
        let previous = json!({
            "limitId": "codex",
            "primary": { "usedPercent": 97, "resetsAt": 1000 },
            "credits": { "balance": "0", "hasCredits": false },
        });
        let update = json!({
            "primary": { "usedPercent": 99, "resetsAt": null },
            "credits": null,
            "spendControlReached": true,
        });
        let merged = merge_rate_limit_snapshot(Some(&previous), &update);
        assert_eq!(merged["primary"]["usedPercent"], 99);
        // `resetsAt: null` in the update must NOT erase the snapshot value.
        assert_eq!(merged["primary"]["resetsAt"], 1000);
        // `credits: null` must NOT erase the snapshot object.
        assert_eq!(merged["credits"]["balance"], "0");
        // New field is added.
        assert_eq!(merged["spendControlReached"], true);
        // limitId preserved.
        assert_eq!(merged["limitId"], "codex");
    }

    #[test]
    fn merge_into_nested_objects_recursively() {
        let previous = json!({ "a": { "b": { "c": 1, "d": 2 } }, "keep": 1 });
        let update = json!({ "a": { "b": { "c": 9 } } });
        let merged = merge_rate_limit_snapshot(Some(&previous), &update);
        assert_eq!(merged["a"]["b"]["c"], 9);
        assert_eq!(merged["a"]["b"]["d"], 2);
        assert_eq!(merged["keep"], 1);
    }

    #[test]
    fn merge_without_previous_returns_update() {
        let update = json!({ "primary": { "usedPercent": 50 } });
        assert_eq!(merge_rate_limit_snapshot(None, &update), update);
    }

    #[test]
    fn merge_non_object_never_overwrites() {
        let previous = json!({ "primary": { "usedPercent": 10 } });
        let merged = merge_rate_limit_snapshot(Some(&previous), &json!(null));
        assert_eq!(merged["primary"]["usedPercent"], 10);
        // Array update into object target: ignored.
        let merged2 = merge_rate_limit_snapshot(Some(&previous), &json!([1, 2]));
        assert_eq!(merged2["primary"]["usedPercent"], 10);
    }

    #[test]
    fn model_catalog_preserves_server_order() {
        let result = json!({
            "data": [
                { "id": "gpt-5.6-sol", "isDefault": true,
                  "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "fast" },
                    { "reasoningEffort": "high", "description": "deep" }
                  ] },
                { "id": "gpt-5.6-luna", "isDefault": false }
            ]
        });
        let catalog = parse_catalog(&result);
        assert_eq!(catalog.data.len(), 2);
        assert_eq!(catalog.data[0].id, "gpt-5.6-sol");
        assert!(catalog.data[0].is_default);
        assert_eq!(
            catalog.data[0].supported_reasoning_efforts[0].reasoning_effort,
            "low"
        );
        assert_eq!(
            catalog.data[0].supported_reasoning_efforts[1].reasoning_effort,
            "high"
        );
        assert_eq!(catalog.data[1].id, "gpt-5.6-luna");
        assert!(catalog.data[1].supported_reasoning_efforts.is_empty());
    }
}
