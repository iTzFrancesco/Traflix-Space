use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;
use tracing::{debug, error, info, warn};

use super::rpc::{JsonRpcClient, ServerMessage};
#[path = "runtime_transport.rs"]
mod runtime_transport;

use self::runtime_transport::{
    configure_hidden_process, kill_pid, probe_version, resolve_codex_executable,
};
use super::types::{
    ClientInfo, CodexRuntimeState, CodexRuntimeStatus, InitializeCapabilities, InitializeParams,
    InitializeResult,
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

impl RuntimeError {
    /// Stable error code for the Jarvis error model (spec §24).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "codex_not_installed",
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
    /// Serializes all start paths (background startup, first voice turn,
    /// settings refresh and explicit restart). Without this guard, multiple
    /// callers can observe `Stopped` before the first caller marks the
    /// runtime as `Starting` and spawn duplicate App Servers.
    start_lock: Arc<Mutex<()>>,
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
    /// Review: bumped on every successful (re)start. Ephemeral threads and
    /// turn correlation of a previous process are invalidated when the
    /// generation changes (crash/restart).
    generation: u64,
    /// Review: cached `account.type` from `account/read` (chatgpt | apiKey |
    /// other). Populated on start so the provider can enforce the
    /// ChatGPT-subscription-only cost guard synchronously.
    account_type: Option<String>,
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
                generation: 0,
                account_type: None,
            })),
            start_lock: Arc::new(Mutex::new(())),
        }
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
        // `ensure_started` intentionally has no reservation state transition:
        // callers may arrive concurrently while resolving/probing the binary.
        // Serialize here and re-check the state so only one child can ever be
        // created for a runtime generation.
        let _start_guard = self.start_lock.lock().await;
        if self.inner.lock().await.state == CodexRuntimeState::Running {
            return Ok(());
        }

        {
            let mut inner = self.inner.lock().await;
            if inner.shutting_down {
                inner.shutting_down = false;
            }
            inner.state = CodexRuntimeState::Starting;
            inner.last_error = None;
        }

        let executable = match self.resolve_executable().await {
            Ok(executable) => executable,
            Err(error) => {
                self.set_failed(&error).await;
                return Err(error);
            }
        };
        info!(executable = %executable.display(), "resolved codex executable");

        // Version is diagnostic metadata only. App Server has no stable
        // cross-release semver contract, so compatibility is established by
        // the live initialize handshake and subsequent RPCs.
        if let Some(version) = probe_version(&executable).await {
            info!(version = %version, "detected codex executable version");
            self.inner.lock().await.version = Some(version);
        } else {
            warn!("could not read codex version; attempting App Server handshake");
        }

        // Spec §5: the App Server must use a dedicated CODEX_HOME so the
        // normal personal Codex profile can never interfere with Jarvis.
        let codex_home_str = super::threads::codex_home_dir(&self.app)?
            .to_string_lossy()
            .to_string();
        {
            let mut inner = self.inner.lock().await;
            inner.codex_home = Some(codex_home_str.clone());
        }

        let mut command = Command::new(&executable);
        configure_hidden_process(&mut command);
        let mut child = command
            .arg("app-server")
            // Spec §5: dedicated CODEX_HOME so the personal ~/.codex profile
            // can never leak into Jarvis.
            .env("CODEX_HOME", &codex_home_str)
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
                    inner.codex_home = Some(
                        init.codex_home
                            .clone()
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or_else(|| codex_home_str.clone()),
                    );
                    inner.platform = init
                        .platform_os
                        .clone()
                        .or_else(|| init.platform_family.clone())
                        .filter(|value| !value.trim().is_empty());
                    inner.consecutive_crashes = 0;
                    // Review: a new process is up — bump the generation so
                    // ephemeral threads/state of a previous process die.
                    inner.generation += 1;
                    let generation = inner.generation;
                    let status = snapshot(&inner);
                    drop(inner);
                    let _ = self.app.emit(RUNTIME_STATUS_EVENT, status);

                    // Review: invalidate everything bound to an older process
                    // (ephemeral threads live in the App Server memory).
                    if generation > 1 {
                        if let Some(threads) = self
                            .app
                            .try_state::<super::threads::ThreadRegistry>()
                            .map(|state| state.inner().clone())
                        {
                            threads.on_runtime_restarted(generation).await;
                        }
                    }

                    // Review: cache the account type so the provider can
                    // enforce the ChatGPT-subscription-only cost guard.
                    // Best-effort: not blocking startup when unauthenticated.
                    if let Ok(result) = client.request("account/read", json!({})).await {
                        let account_type = result
                            .get("account")
                            .and_then(|account| account.get("type"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        self.inner.lock().await.account_type = account_type;
                    }
                }
                info!(
                    user_agent = init.user_agent.as_deref().unwrap_or("unknown"),
                    "codex app-server runtime ready"
                );
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
                        client.clone(),
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
                self.set_failed(&RuntimeError::Handshake(message.clone()))
                    .await;
                child.start_kill().ok();
                Err(RuntimeError::Handshake(message))
            }
            Err(_) => {
                let message = "initialize handshake timed out".to_string();
                self.set_failed(&RuntimeError::Handshake(message.clone()))
                    .await;
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
                inner.account_type = None;
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

            // Review: fail pending chat waiters right away — the turn they
            // wait on died with the process (no 90s hang while we restart).
            if let Some(threads) = this
                .app
                .try_state::<super::threads::ThreadRegistry>()
                .map(|state| state.inner().clone())
            {
                threads.on_runtime_crashed().await;
            }

            if crashes <= MAX_CONSECUTIVE_CRASHES {
                warn!(attempt = crashes, "restarting codex app-server after crash");
                sleep(RESTART_BACKOFF * crashes).await;
                if let Err(err) = this.start().await {
                    warn!(error = %err, "codex app-server restart failed");
                    let mut inner = this.inner.lock().await;
                    if (inner.state == CodexRuntimeState::Crashed
                        || inner.state == CodexRuntimeState::Failed)
                        && inner.consecutive_crashes >= MAX_CONSECUTIVE_CRASHES
                    {
                        inner.state = CodexRuntimeState::Failed;
                        inner.last_error = Some(format!(
                            "codex app-server crashed {} times; restart budget exhausted",
                            inner.consecutive_crashes
                        ));
                        emit_status(&this.app, &inner);
                    }
                }
            } else {
                let mut inner = this.inner.lock().await;
                inner.state = CodexRuntimeState::Failed;
                inner.last_error = Some(format!(
                    "codex app-server crashed {crashes} times; restart budget exhausted"
                ));
                emit_status(&this.app, &inner);
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
        inner.account_type = None;
        emit_status(&self.app, &inner);
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
                return Err(RuntimeError::NotRunning { state: inner.state });
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

    /// C10: synchronous state read for the Jarvis provider `status()` (the
    /// trait is sync). Never blocks: a contended lock is reported as Stopped.
    pub fn current_state(&self) -> CodexRuntimeState {
        self.inner
            .try_lock()
            .map(|inner| inner.state)
            .unwrap_or(CodexRuntimeState::Stopped)
    }

    /// Review: cached `account.type` for the running process (None when
    /// stopped, not yet read, or contended). Sync — used by the provider
    /// `status()` path.
    pub fn current_account_type(&self) -> Option<String> {
        self.inner
            .try_lock()
            .ok()
            .and_then(|inner| inner.account_type.clone())
    }

    /// Current runtime process generation (bumped on every successful
    /// (re)start). Threads bound to older generations are stale.
    pub async fn generation(&self) -> u64 {
        self.inner.lock().await.generation
    }

    /// Refreshes the cached account type (used by the provider when the
    /// boot-time cache was not yet populated).
    pub async fn set_account_type(&self, account_type: Option<String>) {
        self.inner.lock().await.account_type = account_type;
    }

    /// Live RPC client when Running, or the specific failure reason.
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

// ---------------------------------------------------------------------------
// Tauri commands (C1: diagnostics + restart)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jarvis_codex_runtime_status(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexRuntimeStatus, String> {
    Ok(runtime.status().await)
}

/// Starts Codex only after an explicit Jarvis/bridge activation or a real
/// first-turn fallback. Reading diagnostics never starts a child process.
#[tauri::command]
pub async fn jarvis_codex_runtime_start(
    runtime: tauri::State<'_, CodexRuntimeManager>,
) -> Result<CodexRuntimeStatus, String> {
    runtime
        .ensure_started()
        .await
        .map_err(|err| format!("{}: {}", err.code(), err))?;
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
#[path = "runtime_tests.rs"]
mod tests;
