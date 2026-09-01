use serde::{Deserialize, Serialize};

/// JSON-RPC 2.0 version marker used on every envelope.
pub const JSONRPC_VERSION: &str = "2.0";

// ---------------------------------------------------------------------------
// Client -> Server payloads (C1: initialize handshake only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    /// Required for dynamic tools (experimental API surface).
    pub experimental_api: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Optional across App Server generations; used only for diagnostics.
    #[serde(default)]
    pub user_agent: Option<String>,
    /// The runtime falls back to its requested home when this metadata is
    /// absent, which keeps the handshake useful across protocol revisions.
    #[serde(default)]
    pub codex_home: Option<String>,
    #[serde(default)]
    pub platform_family: Option<String>,
    #[serde(default)]
    pub platform_os: Option<String>,
}

// ---------------------------------------------------------------------------
// Runtime diagnostics surfaced to the Settings UI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexRuntimeState {
    /// Not started yet (or already shut down).
    Stopped,
    /// Spawn in progress (executable resolution, handshake).
    Starting,
    /// Handshake completed; requests are accepted.
    Running,
    /// The App Server process exited unexpectedly.
    Crashed,
    /// Permanent failure (not installed, spawn failed, restart budget exhausted).
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeStatus {
    pub state: CodexRuntimeState,
    pub version: Option<String>,
    pub pid: Option<u32>,
    pub codex_home: Option<String>,
    pub platform: Option<String>,
    pub started_at: Option<String>,
    pub handshake_completed: bool,
    pub last_error: Option<String>,
    pub restart_count: u32,
}

#[cfg(test)]
mod tests {
    use super::InitializeResult;
    use serde_json::json;

    #[test]
    fn initialize_result_accepts_full_and_minimal_metadata() {
        let full: InitializeResult = serde_json::from_value(json!({
            "userAgent": "codex-cli 0.152.0",
            "codexHome": "C:/codex-home",
            "platformFamily": "windows",
            "platformOs": "windows"
        }))
        .unwrap();
        assert_eq!(full.user_agent.as_deref(), Some("codex-cli 0.152.0"));
        assert_eq!(full.codex_home.as_deref(), Some("C:/codex-home"));

        let minimal: InitializeResult = serde_json::from_value(json!({})).unwrap();
        assert_eq!(minimal.user_agent, None);
        assert_eq!(minimal.codex_home, None);
    }
}
