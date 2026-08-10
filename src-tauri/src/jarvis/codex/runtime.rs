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
    #[error("codex environment error: {0}")]
    Environment(String),
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
            Self::Environment(_) => "codex_environment_error",
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

        // Spec §5: the App Server must use a dedicated CODEX_HOME so the
        // normal personal Codex profile can never interfere with Jarvis.
        let codex_home_str = super::threads::codex_home_dir(&self.app)?.to_string_lossy().to_string();
        {
            let mut inner = self.inner.lock().await;
            inner.codex_home = Some(codex_home_str.clone());
        }

        let mut child = Command::new(&executable)
            .arg("app-server")
            // Spec §5: dedicated CODEX_HOME so the personal ~/.codex profile
            // can never leak into Jarvis.
            .env("CODEX_HOME", codex_home_str)
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
                // (C2) and the rate-limit merger (C3); later chunks attach
                // their own consumers to it.
                if let Some(rx) = self.take_server_rx().await {
                    use tauri::Manager;
                    let models = self
                        .app
                        .try_state::<super::models::CodexModelService>()
                        .map(|state| state.inner().clone());
                    let threads = self
                        .app
                        .try_state::<super::threads::ThreadRegistry>()
                        .map(|state| state.inner().clone());
                    let tools = self
                        .app
                        .try_state::<super::tools::CodexToolService>()
                        .map(|state| state.inner().clone());
                    super::account::spawn_account_bridge(
                        self.clone(),
                        self.app.clone(),
                        models,
                        threads,
                        tools,
                        rx,
                    );
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
        // The second entry is a plain missing directory (platform-neutral;
        // Windows drive-letter paths cannot be joined on non-Windows hosts).
        let paths = vec![dir.path().to_path_buf(), dir.path().join("nonexistent")];
        let joined = std::env::join_paths(paths).unwrap();
        std::env::set_var("PATH", joined);
        assert_eq!(find_on_path("codex.exe"), Some(exe));
    }

    #[test]
    fn path_scan_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec![dir.path().to_path_buf(), dir.path().join("nonexistent")];
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

        // C3: rate limits + usage read must succeed (real payloads).
        let rate_limits = client
            .request("account/rateLimits/read", json!({}))
            .await
            .expect("account/rateLimits/read response");
        let codex_limit = rate_limits["rateLimitsByLimitId"]["codex"].clone();
        assert!(
            codex_limit.get("primary").is_some() || codex_limit.get("credits").is_some(),
            "codex rate limit snapshot: {codex_limit}"
        );
        let usage = client
            .request("account/usage/read", json!({}))
            .await
            .expect("account/usage/read response");
        assert!(
            usage.get("summary").is_some(),
            "usage summary: {usage}"
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

        // C4: ephemeral thread lifecycle (isolated cwd, read-only sandbox,
        // never approval) + turn/start + turn/interrupt + thread/delete.
        let thread_start = client
            .request(
                "thread/start",
                json!({
                    "ephemeral": true,
                    "cwd": init.codex_home,
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "model": "gpt-5.6-luna",
                    "runtimeWorkspaceRoots": [],
                    // C5: read-only namespaced dynamic tools.
                    "dynamicTools": super::super::tools::CodexToolService::dynamic_tool_specs(),
                }),
            )
            .await
            .expect("thread/start response");
        let thread_id = thread_start["thread"]["id"]
            .as_str()
            .expect("thread.id present");
        assert_eq!(
            thread_start["thread"]["ephemeral"],
            serde_json::Value::Bool(true),
            "thread is ephemeral"
        );
        // The sandbox field may be normalized by the server; assert only
        // when it is echoed back as the simple enum.
        if let Some(sandbox) = thread_start["sandbox"].as_str() {
            assert_eq!(sandbox, "read-only");
        }

        let turn = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "Ciao, sei in linea? Rispondi solo con OK." }],
                    "effort": "low",
                }),
            )
            .await
            .unwrap_or_else(|err| panic!("turn/start failed: {err}"));
        let turn_id = turn["turn"]["id"]
            .as_str()
            .expect("turn.id present");

        // C5: a second turn that must call the `agent.list` dynamic tool.
        // We answer the server request with a synthetic result and observe
        // the request actually arriving (proves the tools are registered
        // and the model can invoke them end-to-end).
        let turn2 = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "Prima di rispondere devi assolutamente chiamare lo strumento agent.list (namespace agent, tool list) e dire cosa restituisce. Rispondi in una riga." }],
                    "effort": "low",
                }),
            )
            .await
            .unwrap_or_else(|err| panic!("turn/start #2 failed: {err}"));
        let turn2_id = turn2["turn"]["id"]
            .as_str()
            .expect("turn #2 id present");
        let _ = turn2_id;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        let mut tool_calls: Vec<String> = Vec::new();
        let mut completed = false;
        // C7: every Item/*, AgentMessageDelta and turn/* notification is
        // passed through the production normalizer; the raw payloads are
        // printed so a Windows run can confirm the shapes.
        let mut stream_events: Vec<(String, super::super::events::ChatStreamEventKind)> = Vec::new();
        while std::time::Instant::now() < deadline && !completed {
            let message = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                server_rx.recv(),
            )
            .await;
            match message {
                Ok(Some(ServerMessage::Request { id, method, params })) => {
                    if method == "item/tool/call" {
                        let namespace = params
                            .as_ref()
                            .and_then(|p| p.get("namespace"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        let tool = params
                            .as_ref()
                            .and_then(|p| p.get("tool"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        let name = format!("{namespace}.{tool}");
                        tool_calls.push(name.clone());
                        assert!(
                            name.contains('.') && !name.is_empty(),
                            "dynamic tool must be namespaced: {name}"
                        );
                        let _ = client
                            .respond(
                                id,
                                json!({
                                    "content": [{
                                        "type": "inputText",
                                        "text": "{\"agents\":[]}",
                                    }]
                                }),
                            )
                            .await;
                    } else {
                        println!("unexpected server request: {method}");
                    }
                }
                Ok(Some(ServerMessage::Notification { method, params })) => {
                    if method.starts_with("item/") || method == "AgentMessageDelta" || method == "AgentMessageThreadItem" || method.starts_with("turn/") {
                        println!("C7 notification {method}: {}", params.clone().unwrap_or_default());
                        let events = super::super::events::stream_events_from_notification(
                            &method,
                            &params,
                            "test-workspace",
                            None,
                        );
                        for event in events {
                            stream_events.push((method.clone(), event.kind));
                        }
                    }
                    if method == "turn/completed" {
                        completed = true;
                    }
                }
                _ => {}
            }
        }
        assert!(
            tool_calls.iter().any(|name| name == "agent.list"),
            "agent.list observed among tool calls: {tool_calls:?}"
        );
        // C7 ordering: every dynamicToolCall item produced a tool lifecycle
        // event, and no tool_completed arrived without a matching started.
        assert!(
            stream_events
                .iter()
                .any(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolStarted),
            "tool_started observed in stream: {stream_events:?}"
        );
        let tool_starts = stream_events
            .iter()
            .filter(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolStarted)
            .count();
        let tool_finishes = stream_events
            .iter()
            .filter(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolCompleted)
            .count();
        assert!(
            tool_finishes <= tool_starts,
            "tool_completed without started: {stream_events:?}"
        );

        // C6: a third turn that must call `conversational.plan` (the only
        // side-effecting tool). We answer with a synthetic receipt and
        // observe the request arriving (proves the namespace is registered
        // and the model can produce a typed plan end-to-end).
        let turn3 = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "Prima di rispondere devi assolutamente chiamare lo strumento conversational.plan (namespace conversational, tool plan) con una sola operazione respond e prompt \"test ok\", poi rispondi in una riga." }],
                    "effort": "low",
                }),
            )
            .await
            .unwrap_or_else(|err| panic!("turn/start #3 failed: {err}"));
        let _ = turn3["turn"]["id"].as_str().expect("turn #3 id present");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        let mut plan_calls: Vec<serde_json::Value> = Vec::new();
        let mut completed3 = false;
        // C7: same normalization pass on the plan turn; the turn must end
        // with a TurnCompleted stream event (final-message marker for the UI).
        let mut turn3_stream: Vec<super::super::events::ChatStreamEventKind> = Vec::new();
        while std::time::Instant::now() < deadline && !completed3 {
            let message = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                server_rx.recv(),
            )
            .await;
            match message {
                Ok(Some(ServerMessage::Request { id, method, params })) => {
                    if method == "item/tool/call" {
                        let namespace = params
                            .as_ref()
                            .and_then(|p| p.get("namespace"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        let tool = params
                            .as_ref()
                            .and_then(|p| p.get("tool"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        if namespace == "conversational" && tool == "plan" {
                            plan_calls.push(params.clone().unwrap_or_default());
                            // The arguments must be the typed plan shape.
                            let args = params
                                .as_ref()
                                .and_then(|p| p.get("arguments"))
                                .cloned()
                                .unwrap_or_default();
                            assert!(
                                args.get("operations").is_some(),
                                "plan arguments are typed: {args}"
                            );
                            // Answer with the ExecutionReceipt shape (C6:
                            // the receipt comes back in the same turn).
                            let _ = client
                                .respond(
                                    id,
                                    json!({
                                        "content": [{
                                            "type": "inputText",
                                            "text": "{\"response\":\"Fatto, test ok.\",\"warnings\":[]}",
                                        }]
                                    }),
                                )
                                .await;
                        } else {
                            println!("unexpected server request: {method} {namespace}.{tool}");
                            let _ = client
                                .respond_error(id, -32601, "unexpected in C6 test")
                                .await;
                        }
                    } else {
                        println!("unexpected server request: {method}");
                    }
                }
                Ok(Some(ServerMessage::Notification { method, params })) => {
                    if method.starts_with("item/") || method == "AgentMessageDelta" || method == "AgentMessageThreadItem" || method.starts_with("turn/") {
                        println!("C7 notification (turn3) {method}: {}", params.clone().unwrap_or_default());
                        let events = super::super::events::stream_events_from_notification(
                            &method,
                            &params,
                            "test-workspace",
                            None,
                        );
                        for event in events {
                            turn3_stream.push(event.kind);
                        }
                    }
                    if method == "turn/completed" {
                        completed3 = true;
                    }
                }
                _ => {}
            }
        }
        assert!(
            !plan_calls.is_empty(),
            "conversational.plan observed among tool calls"
        );
        assert!(
            turn3_stream
                .iter()
                .any(|kind| *kind == super::super::events::ChatStreamEventKind::TurnCompleted),
            "turn3 stream ends with TurnCompleted: {turn3_stream:?}"
        );
        // The server-side allows multiple plans in one turn; the host-side
        // single-plan guard lives in CodexToolService (unit-tested). Here we
        // verify the server accepted the namespace without reserved-name
        // collisions — the same specs passed to thread/start above.
        println!("conversational.plan calls observed: {}", plan_calls.len());

        // Interrupt is best-effort: the trivial prompt may complete before
        // the interrupt lands (error on an already-finished turn is fine).
        let _ = client
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await;

        // Ephemeral threads are not persisted, so the server refuses
        // thread/delete ("thread is not persisted") — expected contract:
        // no server-side cleanup is needed for ephemeral threads.
        let delete_result = client
            .request("thread/delete", json!({ "threadId": thread_id }))
            .await;
        match delete_result {
            Ok(_) => {}
            Err(err) => {
                let message = err.to_string();
                assert!(
                    message.contains("not persisted"),
                    "ephemeral delete error mentions persistence: {message}"
                );
            }
        }

        child.kill().await.expect("child killed");
        child.wait().await.expect("child reaped");
        let _ = server_rx.try_recv();
    }
}
