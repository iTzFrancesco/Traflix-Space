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
    pub user_agent: String,
    pub codex_home: String,
    #[allow(dead_code)]
    pub platform_family: String,
    pub platform_os: String,
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

/// Minimum supported App Server version. The protocol surface (especially
/// dynamic tools) is experimental: below this version we fail closed instead
/// of trying to interpret unknown payloads.
pub const MIN_SUPPORTED_CODEX_VERSION: (u32, u32, u32) = (0, 147, 0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl CodexVersion {
    /// Parses `codex-cli 0.147.0` style output. Returns `None` for anything
    /// that does not look like a numeric semver triple.
    pub fn parse_cli(output: &str) -> Option<Self> {
        let token = output
            .split_whitespace()
            .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
        let mut parts = token.trim().split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
        })
    }

    pub fn is_supported(&self) -> bool {
        let (min_major, min_minor, min_patch) = MIN_SUPPORTED_CODEX_VERSION;
        (self.major, self.minor, self.patch) >= (min_major, min_minor, min_patch)
    }
}

#[cfg(test)]
mod tests {
    use super::{CodexVersion, MIN_SUPPORTED_CODEX_VERSION};

    #[test]
    fn parses_cli_version_output() {
        assert_eq!(
            CodexVersion::parse_cli("codex-cli 0.147.0"),
            Some(CodexVersion {
                major: 0,
                minor: 147,
                patch: 0
            })
        );
        assert_eq!(
            CodexVersion::parse_cli("codex 1.2.3 (abc123)"),
            Some(CodexVersion {
                major: 1,
                minor: 2,
                patch: 3
            })
        );
        assert_eq!(CodexVersion::parse_cli(""), None);
        assert_eq!(CodexVersion::parse_cli("codex-cli"), None);
        assert_eq!(CodexVersion::parse_cli("codex-cli 0.147"), None);
        assert_eq!(CodexVersion::parse_cli("abc 0.x.y"), None);
    }

    #[test]
    fn minimum_supported_version_boundary() {
        let (maj, min, pat) = MIN_SUPPORTED_CODEX_VERSION;
        assert!(
            CodexVersion {
                major: maj,
                minor: min,
                patch: pat
            }
            .is_supported()
        );
        assert!(CodexVersion {
            major: maj,
            minor: min,
            patch: pat + 1
        }
        .is_supported());
        assert!(!CodexVersion {
            major: maj,
            minor: min.saturating_sub(1),
            patch: 999
        }
        .is_supported());
        assert!(CodexVersion {
            major: maj + 1,
            minor: 0,
            patch: 0
        }
        .is_supported());
    }
}
