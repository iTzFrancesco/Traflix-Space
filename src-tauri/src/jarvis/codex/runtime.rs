use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;
use tracing::{debug, error, info, warn};

use super::rpc::{JsonRpcClient, ServerMessage};
use super::types::{
    ClientInfo, CodexRuntimeState, CodexRuntimeStatus, CodexVersion, InitializeCapabilities,
    InitializeParams, InitializeResult, MIN_SUPPORTED_CODEX_VERSION,
};

/// Global Tauri event carrying runtime status snapshots to the UI.
pub const RUNTIME_STATUS_EVENT: &str = "jarvis://codex-runtime";

/// How many consecutive crashes trigger a permanent `Failed` state instead of
/// another auto-restart.
const MAX_CONSECUTIVE_CRASHES: u32 = 3;
/// Backoff between auto-restarts after a crash (multiplied by attempt count).
const RESTART_BACKOFF: Duration = Duration::from_secs(2);
/// Bounded wait for the `initialize` handshake response.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, thiserror::Error)]
pub enum RuntimeError {
    #[error("codex executable not found: {0}")]
    NotFound(String),
    #[error(
        "codex version too old: found {found}, minimum supported {minimum}",
        minimum = display_version(*.minimum)
    )]
    VersionTooOld {
        found: String,
        minimum: (u32, u32, u32),
    },
    #[error("failed to spawn codex app-server: {0}")]
    Spawn(String),
    #[error("codex app-server handshake failed: {0}")]
    Handshake(String),
    #[error("codex app-server is not running (state={state:?})")]
    NotRunning { state: CodexRuntimeState },
    #[error("codex app-server RPC failed: {0}")]
    Rpc(String),
}

fn display_version(version: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", version.0, version.1, version.2)
}

impl RuntimeError {
    /// Stable error code for the Jarvis error model (spec §24).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "codex_not_installed",
            Self::VersionTooOld { .. } => "codex_version_mismatch",
            Self::Spawn(_) | Self::Handshake(_) => "codex_runtime_start_failed",
            Self::NotRunning { .. } => "codex_runtime_crashed",
            Self::Rpc(_) => "codex_rpc_failed",
        }
    }
}

/// Shared handle to the single global Codex App Server process.
///
/// One instance lives for the whole Traflix Space session (spec §3, §4):
/// it spawns `codex app-server` over stdio, performs the initialize
/// handshake, observes crashes and restarts the runtime within a bounded
/// budget, and shuts the child down when Space exits.
#[derive(Clone)]
pub struct CodexRuntimeManager {
    app: AppHandle,
    inner: Arc<Mutex<RuntimeInner>>,
}

struct RuntimeInner {
    state: CodexRuntimeState,
    version: Option<String>,
    pid: Option<u32>,
    codex_home: Option<String>,
    platform: Option<String>,
    started_at: Option<Instant>,
    last_error: Option<String>,
    restart_count: u32,
    consecutive_crashes: u32,
    client: Option<Arc<JsonRpcClient>>,
    server_rx: Option<mpsc::UnboundedReceiver<ServerMessage>>,
    executable: Option<PathBuf>,
    shutting_down: bool,
}

impl CodexRuntimeManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Arc::new(Mutex::new(RuntimeInner {
                state: CodexRuntimeState::Stopped,
                version: None,
                pid: None,
                codex_home: None,
                platform: None,
                started_at: None,
                last_error: None,
                restart_count: 0,
                consecutive_crashes: 0,
                client: None,
                server_rx: None,
                executable: None,
                shutting_down: false,
            })),
        }
    }

    /// Best-effort startup performed once at app setup. Never blocks setup:
    /// the runtime warms in the background and the first Jarvis request can
    /// await readiness.
    pub fn start_in_background(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = this.ensure_started().await {
                warn!(error = %err, "codex runtime background startup failed");
            }
        });
    }

    /// Ensures the runtime is Running; starts it if not. Concurrent callers
    /// wait for the in-flight start instead of spawning a second process.
    pub async fn ensure_started(&self) -> Result<(), RuntimeError> {
        loop {
            let state = {
                let inner = self.inner.lock().await;
                match inner.state {
                    CodexRuntimeState::Running => return Ok(()),
                    CodexRuntimeState::Starting => inner.state,
                    CodexRuntimeState::Failed | CodexRuntimeState::Crashed => {
                        let state = inner.state;
                        let last_error = inner.last_error.clone();
                        drop(inner);
                        if let Some(err) = last_error {
                            warn!(error = %err, "codex runtime not running");
                        }
                        return Err(RuntimeError::NotRunning { state });
                    }
                    CodexRuntimeState::Stopped => break,
                }
            };
            sleep(Duration::from_millis(200)).await;
            if state == CodexRuntimeState::Starting {
                // Keep waiting for the concurrent start to finish.
                continue;
            }
        }
        self.start().await
    }

    async fn start(&self) -> Result<(), RuntimeError> {
        let executable = self.resolve_executable().await?;

        // Version gate (spec §25: fail closed below minimum supported).
        if let Some(version) = probe_version(&executable).await {
            match CodexVersion::parse_cli(&version) {
                Some(parsed) if !parsed.is_supported() => {
                    let err = RuntimeError::VersionTooOld {
                        found: version,
                        minimum: MIN_SUPPORTED_CODEX_VERSION,
                    };
                    self.set_failed(&err).await;
                    return Err(err);
                }
                None => warn!(version, "unparseable codex version; proceeding"),
                _ => {}
            }
            self.inner.lock().await.version = Some(version);
        }

        {
            let mut inner = self.inner.lock().await;
            inner.state = CodexRuntimeState::Starting;
            inner.last_error = None;
        }

        let mut child = Command::new(&executable)
            .arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| {
                let message = err.to_string();
                let message_spawn = message.clone();
                let state = self.inner.clone();
                let handle = self.app.clone();
                tauri::async_runtime::spawn(async move {
                    let mut inner = state.lock().await;
                    inner.state = CodexRuntimeState::Failed;
                    inner.last_error = Some(message_spawn.clone());
                    let status = snapshot(&inner);
                    drop(inner);
                    let _ = handle.emit(RUNTIME_STATUS_EVENT, status);
                });
                RuntimeError::Spawn(message)
            })?;

        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        // stderr is consumed by a task so the pipe never fills up; App Server
        // writes diagnostics there. We only log it, never parse it.
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = line.trim_end_matches(['\r', '\n']);
                        if !text.is_empty() {
                            debug!("codex stderr: {text}");
                        }
                    }
                }
            }
        });

        let (client, server_rx) = JsonRpcClient::new(stdin);
        let client = Arc::new(client);
        client.start_reader(stdout);

        {
            let mut inner = self.inner.lock().await;
            inner.pid = child.id();
            inner.client = Some(client.clone());
            inner.server_rx = Some(server_rx);
            inner.started_at = Some(Instant::now());
        }

        // Handshake: initialize -> initialized (spec §4).
        let init_result = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            client.request(
                "initialize",
                json!(InitializeParams {
                    client_info: ClientInfo {
                        name: "traflix-space".into(),
                        title: "Traflix Space".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    capabilities: InitializeCapabilities {
                        experimental_api: true,
                    },
                }),
            ),
        )
        .await;

        match init_result {
            Ok(Ok(result)) => {
                let init: InitializeResult = serde_json::from_value(result)
                    .map_err(|err| RuntimeError::Handshake(err.to_string()))?;
                client
                    .notify("initialized", json!({}))
                    .await
                    .map_err(|err| RuntimeError::Handshake(err.to_string()))?;

                {
                    let mut inner = self.inner.lock().await;
                    inner.state = CodexRuntimeState::Running;
                    inner.codex_home = Some(init.codex_home.clone());
                    inner.platform = Some(init.platform_os.clone());
                    inner.consecutive_crashes = 0;
                    let status = snapshot(&inner);
                    drop(inner);
                    let _ = self.app.emit(RUNTIME_STATUS_EVENT, status);
                }
                info!(user_agent = %init.user_agent, "codex app-server runtime ready");
                // Hand the server-notification channel to the account bridge
                // (C2); later chunks attach their own consumers to it.
                if let Some(rx) = self.take_server_rx().await {
                    super::account::spawn_account_bridge(self.clone(), self.app.clone(), rx);
                }
                self.spawn_monitor(child);
                Ok(())
            }
            Ok(Err(err)) => {
                let message = err.to_string();
                self.set_failed(&RuntimeError::Handshake(message.clone())).await;
                child.start_kill().ok();
                Err(RuntimeError::Handshake(message))
            }
            Err(_) => {
                let message = "initialize handshake timed out".to_string();
                self.set_failed(&RuntimeError::Handshake(message.clone())).await;
                child.start_kill().ok();
                Err(RuntimeError::Handshake(message))
            }
        }
    }

    /// Observes the child process and reacts to unexpected exits (spec §4:
    /// "osservare crash o uscita; riavviare il runtime quando appropriato").
    fn spawn_monitor(&self, mut child: Child) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let exit = child.wait().await;
            let status = exit
                .as_ref()
                .map(|s| s.to_string())
                .unwrap_or_else(|err| err.to_string());

            let (_shutting_down, crashes) = {
                let mut inner = this.inner.lock().await;
                inner.client = None;
                inner.server_rx = None;
                inner.pid = None;
                if inner.shutting_down {
                    inner.state = CodexRuntimeState::Stopped;
                    return;
                }
                inner.consecutive_crashes += 1;
                inner.state = CodexRuntimeState::Crashed;
                inner.last_error = Some(format!("codex app-server exited: {status}"));
                let crashes = inner.consecutive_crashes;
                let status_snapshot = snapshot(&inner);
                drop(inner);
                let _ = this.app.emit(RUNTIME_STATUS_EVENT, status_snapshot);
                (false, crashes)
            };
            error!(status, "codex app-server exited unexpectedly");

            if crashes <= MAX_CONSECUTIVE_CRASHES {
                warn!(attempt = crashes, "restarting codex app-server after crash");
                sleep(RESTART_BACKOFF * crashes).await;
                if let Err(err) = this.start().await {
                    warn!(error = %err, "codex app-server restart failed");
                    let mut inner = this.inner.lock().await;
                    if inner.state == CodexRuntimeState::Crashed
                        || inner.state == CodexRuntimeState::Failed
                    {
                        if inner.consecutive_crashes >= MAX_CONSECUTIVE_CRASHES {
                            inner.state = CodexRuntimeState::Failed;
                            inner.last_error = Some(format!(
                                "codex app-server crashed {} times; restart budget exhausted",
                                inner.consecutive_crashes
                            ));
                            emit_status(&this.app, &*inner);
                        }
                    }
                }
            } else {
                let mut inner = this.inner.lock().await;
                inner.state = CodexRuntimeState::Failed;
                inner.last_error = Some(format!(
                    "codex app-server crashed {crashes} times; restart budget exhausted"
                ));
                emit_status(&this.app, &*inner);
            }
        });
    }

    async fn set_failed(&self, err: &RuntimeError) {
        let mut inner = self.inner.lock().await;
        inner.state = CodexRuntimeState::Failed;
        inner.last_error = Some(err.to_string());
        inner.client = None;
        inner.server_rx = None;
        inner.pid = None;
        emit_status(&self.app, &*inner);
    }

    async fn resolve_executable(&self) -> Result<PathBuf, RuntimeError> {
        let inner = self.inner.lock().await;
        if let Some(exe) = inner.executable.clone() {
            return Ok(exe);
        }
        drop(inner);
        let resolved = resolve_codex_executable().map_err(RuntimeError::NotFound)?;
        self.inner.lock().await.executable = Some(resolved.clone());
        Ok(resolved)
    }

    /// Graceful shutdown: marks the runtime as shutting down so the monitor
    /// does not auto-restart, then kills the child.
    pub async fn shutdown(&self) {
        let pid = {
            let mut inner = self.inner.lock().await;
            if inner.shutting_down {
                return;
            }
            inner.shutting_down = true;
            inner.state = CodexRuntimeState::Stopped;
            inner.client = None;
            inner.server_rx = None;
            inner.pid.take()
        };
        if let Some(pid) = pid {
            let _ = kill_pid(pid);
        }
        info!("codex app-server shutdown requested");
    }

    /// Explicit user-requested restart (Settings UI "Restart Codex").
    pub async fn restart(&self) -> Result<(), RuntimeError> {
        let pid = {
            let mut inner = self.inner.lock().await;
            if inner.shutting_down {
                return Err(RuntimeError::NotRunning {
                    state: inner.state,
                });
            }
            inner.shutting_down = false;
            inner.restart_count += 1;
            inner.consecutive_crashes = 0;
            inner.client = None;
            inner.server_rx = None;
            inner.state = CodexRuntimeState::Stopped;
            inner.pid.take()
        };
        if let Some(pid) = pid {
            let _ = kill_pid(pid);
        }
        // Give the old process a moment to release the pipes before respawn.
        sleep(Duration::from_millis(300)).await;
        self.start().await
    }

    /// Point-in-time diagnostics snapshot (spec §4 "runtime diagnostics").
    pub async fn status(&self) -> CodexRuntimeStatus {
        let inner = self.inner.lock().await;
        snapshot(&inner)
    }

    /// Live RPC client when Running, or the specific failure reason.
    /// Consumed by later chunks (account C2, models C3, threads C4).
    #[allow(dead_code)]
    pub async fn client(&self) -> Result<Arc<JsonRpcClient>, RuntimeError> {
        let inner = self.inner.lock().await;
        match (&inner.client, inner.state) {
            (Some(client), CodexRuntimeState::Running) => Ok(client.clone()),
            (_, state) => Err(RuntimeError::NotRunning { state }),
        }
    }

    /// Takes ownership of the server-notification channel. Called exactly
    /// once per process lifetime (after each successful start); the channel
    /// dies with the process and is recreated on restart.
    pub async fn take_server_rx(&self) -> Option<mpsc::UnboundedReceiver<ServerMessage>> {
        self.inner.lock().await.server_rx.take()
    }
}

fn snapshot(inner: &RuntimeInner) -> CodexRuntimeStatus {
    CodexRuntimeStatus {
        state: inner.state,
        version: inner.version.clone(),
        pid: inner.pid,
        codex_home: inner.codex_home.clone(),
        platform: inner.platform.clone(),
        started_at: inner.started_at.map(|t| {
            let secs = t.elapsed().as_secs();
            if secs < 60 {
                format!("{secs}s")
            } else {
                format!("{}m", secs / 60)
            }
        }),
        handshake_completed: inner.state == CodexRuntimeState::Running,
        last_error: inner.last_error.clone(),
        restart_count: inner.restart_count,
    }
}

fn emit_status(app: &AppHandle, inner: &RuntimeInner) {
    let status = snapshot(inner);
    let _ = app.emit(RUNTIME_STATUS_EVENT, status);
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> std::io::Result<()> {
    std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .spawn()?
        .wait()?;
    Ok(())
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) -> std::io::Result<()> {
    let _ = unsafe { libc_kill(pid as i32, 15) };
    Ok(())
}

#[cfg(not(windows))]
extern "C" {
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

/// Resolves the `codex` executable. Order:
/// 1. `codex.exe` on PATH;
/// 2. npm global install layout (the `codex` shim on Windows is a POSIX
///    script, so we resolve the vendored native binary directly);
/// 3. `codex.cmd` / `codex` on PATH as last resort (spawned via shell).
pub fn resolve_codex_executable() -> Result<PathBuf, String> {
    if let Some(path) = find_on_path("codex.exe") {
        return Ok(path);
    }
    if let Some(path) = find_npm_codex_exe() {
        return Ok(path);
    }
    if let Some(path) = find_on_path("codex.cmd") {
        return Ok(path);
    }
    if let Some(path) = find_on_path("codex") {
        return Ok(path);
    }
    Err("codex executable not found on PATH or in npm global layout".into())
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_npm_codex_exe() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let npm_root = Path::new(&appdata).join("npm").join("node_modules");
    let pkg = npm_root.join("@openai").join("codex");
    let candidates = [
        pkg.join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe"),
        pkg.join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Runs `codex --version` once; returns the raw first line (e.g.
/// `codex-cli 0.147.0`).
async fn probe_version(executable: &Path) -> Option<String> {
    let output = Command::new(executable)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or_default().trim();
    (!first.is_empty()).then(|| first.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands (C1: diagnostics + restart)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jarvis_codex_runtime_status(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexRuntimeStatus, String> {
    Ok(runtime.status().await)
}

#[tauri::command]
pub async fn jarvis_codex_runtime_restart(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexRuntimeStatus, String> {
    runtime
        .restart()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))?;
    Ok(runtime.status().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_executable_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("codex.exe");
        fs::write(&exe, b"MZ").unwrap();
        let paths = vec![dir.path().to_path_buf(), PathBuf::from("C:\\nonexistent")];
        let joined = std::env::join_paths(paths).unwrap();
        std::env::set_var("PATH", joined);
        assert_eq!(find_on_path("codex.exe"), Some(exe));
    }

    #[test]
    fn path_scan_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec![dir.path().to_path_buf(), PathBuf::from("C:\\nonexistent")];
        let joined = std::env::join_paths(paths).unwrap();
        std::env::set_var("PATH", joined);
        assert!(find_on_path("codex.exe").is_none());
        assert!(find_on_path("codex.cmd").is_none());
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            RuntimeError::NotFound("x".into()).code(),
            "codex_not_installed"
        );
        assert_eq!(
            RuntimeError::VersionTooOld {
                found: "0.1.0".into(),
                minimum: (0, 147, 0)
            }
            .code(),
            "codex_version_mismatch"
        );
        assert_eq!(
            RuntimeError::Spawn("boom".into()).code(),
            "codex_runtime_start_failed"
        );
        assert_eq!(
            RuntimeError::NotRunning {
                state: CodexRuntimeState::Crashed
            }
            .code(),
            "codex_runtime_crashed"
        );
    }

    /// Real end-to-end smoke test against the installed `codex app-server`.
    /// Requires codex >= 0.147.0 on PATH (or npm global layout). Run with
    /// `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "requires real codex app-server binary"]
    async fn spawns_real_app_server_and_handshakes() {
        let executable = resolve_codex_executable().expect("codex executable resolved");
        let version = probe_version(&executable)
            .await
            .expect("codex --version produces output");
        let parsed = CodexVersion::parse_cli(&version).expect("version parses");
        assert!(
            parsed.is_supported(),
            "installed codex {version} is below minimum supported"
        );

        let mut child = Command::new(&executable)
            .arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn codex app-server");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (client, mut server_rx) = JsonRpcClient::new(stdin);
        let client = Arc::new(client);
        client.start_reader(stdout);

        let init: InitializeResult = serde_json::from_value(
            client
                .request(
                    "initialize",
                    json!(InitializeParams {
                        client_info: ClientInfo {
                            name: "traflix-space-test".into(),
                            title: "Traflix Space (test)".into(),
                            version: "0.0.0-test".into(),
                        },
                        capabilities: InitializeCapabilities {
                            experimental_api: true,
                        },
                    }),
                )
                .await
                .expect("initialize response"),
        )
        .expect("initialize result shape");
        assert_eq!(init.platform_family, "windows");
        assert!(init.codex_home.contains("codex"));

        client
            .notify("initialized", json!({}))
            .await
            .expect("initialized notification");

        // account/read requires an explicit (possibly empty) params object.
        let account = client
            .request("account/read", json!({}))
            .await
            .expect("account/read response");
        assert!(
            account.get("account").is_some() || account.get("requiresOpenaiAuth").is_some(),
            "account/read result: {account}"
        );
        // Parse the real payload with the production view builder.
        let view = super::super::account::parse_account(account.get("account"));
        match view {
            super::super::account::CodexAccount::Chatgpt { plan_type, .. } => {
                assert!(!plan_type.is_empty(), "real chatgpt planType");
            }
            super::super::account::CodexAccount::SignedOut
            | super::super::account::CodexAccount::ApiKey
            | super::super::account::CodexAccount::Other { .. } => {}
        }

        // model/list must expose the Jarvis default family.
        let models = client
            .request("model/list", json!({}))
            .await
            .expect("model/list response");
        let ids: Vec<&str> = models["data"]
            .as_array()
            .expect("model list data")
            .iter()
            .filter_map(|m| m["id"].as_str())
            .collect();
        assert!(
            ids.iter().any(|id| *id == "gpt-5.6-luna"),
            "gpt-5.6-luna present in {ids:?}"
        );

        // account/login/start (chatgpt) must return authUrl+loginId; we
        // immediately cancel the flow so no OAuth session is left pending.
        let login = client
            .request(
                "account/login/start",
                json!({
                    "type": "chatgpt",
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "chatgpt",
                }),
            )
            .await
            .expect("account/login/start response");
        let auth_url = login
            .get("authUrl")
            .and_then(serde_json::Value::as_str)
            .expect("authUrl present");
        let login_id = login
            .get("loginId")
            .and_then(serde_json::Value::as_str)
            .expect("loginId present");
        assert!(auth_url.starts_with("https://"), "authUrl is https: {auth_url}");
        let _ = client
            .request("account/login/cancel", json!({ "loginId": login_id }))
            .await;

        child.kill().await.expect("child killed");
        child.wait().await.expect("child reaped");
        let _ = server_rx.try_recv();
    }
}
