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

/// Supported App Server version. The protocol surface (especially dynamic
/// tools) is experimental: Jarvis is verified against the **0.147.x** wire
/// contract (dynamic-tool server requests are answered with
/// `{content: [...]}`). The official protocol has since moved to
/// `{contentItems, success}` — outside the verified minor we fail closed
/// instead of guessing at unknown payload shapes.
pub const SUPPORTED_CODEX_VERSION: (u32, u32, u32) = (0, 147, 0);

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

    /// Review: exact minor pin. Only `0.147.x` is supported — the official
    /// dynamicTools response moved to `{contentItems, success}`, so any
    /// other minor would be parsed with the wrong contract.
    pub fn is_supported(&self) -> bool {
        let (major, minor, _) = SUPPORTED_CODEX_VERSION;
        self.major == major && self.minor == minor
    }
}

#[cfg(test)]
mod tests {
    use super::{CodexVersion, SUPPORTED_CODEX_VERSION};

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
    fn supported_version_is_pinned_to_the_verified_minor() {
        // 0.147.x is the verified contract (dynamic tools `{content: [...]}`).
        assert!(CodexVersion {
            major: 0,
            minor: 147,
            patch: 0
        }
        .is_supported());
        assert!(CodexVersion {
            major: 0,
            minor: 147,
            patch: 9
        }
        .is_supported());
        // Older minors and any other minor/major fail closed: the official
        // protocol moved to `{contentItems, success}` for dynamic tools.
        assert!(!CodexVersion {
            major: 0,
            minor: 146,
            patch: 0
        }
        .is_supported());
        assert!(!CodexVersion {
            major: 0,
            minor: 148,
            patch: 0
        }
        .is_supported());
        assert!(!CodexVersion {
            major: 1,
            minor: 147,
            patch: 0
        }
        .is_supported());
    }

    #[test]
    fn supported_version_boundary() {
        let (maj, min, _pat) = SUPPORTED_CODEX_VERSION;
        // Any patch of the pinned minor is fine.
        assert!(CodexVersion {
            major: maj,
            minor: min,
            patch: 0
        }
        .is_supported());
        assert!(CodexVersion {
            major: maj,
            minor: min,
            patch: 999
        }
        .is_supported());
        // One minor below/above fails closed.
        assert!(!CodexVersion {
            major: maj,
            minor: min.saturating_sub(1),
            patch: 999
        }
        .is_supported());
        assert!(!CodexVersion {
            major: maj,
            minor: min + 1,
            patch: 0
        }
        .is_supported());
        assert!(!CodexVersion {
            major: maj + 1,
            minor: min,
            patch: 0
        }
        .is_supported());
    }
}
