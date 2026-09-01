use super::TerminalSession;
use crate::agent_events::{agent_event_pipe_name, AGENT_EVENT_PROTOCOL};
use crate::terminal_engine::frame::{TerminalExited, TerminalOutput};
use crate::terminal_engine::grid::GridBuffer;
use crate::terminal_engine::parser::AnsiParser;
use crate::terminal_engine::TerminalAgentSnapshot;
use portable_pty::{CommandBuilder, PtySize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl TerminalSession {
    pub async fn spawn(&mut self, app: AppHandle) -> Result<(), String> {
        if self.pty.is_some() {
            return Ok(());
        }

        // Allow re-spawn after a previous kill on a reused session struct
        // (normally sessions are removed from the map; reopen creates fresh ones).
        self.reader_stop.store(false, Ordering::Relaxed);
        self.exit_emitted.store(false, Ordering::Relaxed);
        self.process_exit_code.store(-1, Ordering::Release);
        self.output_sequence.store(0, Ordering::Release);

        let pty_system = portable_pty::native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: self.grid.rows,
                cols: self.grid.cols,
                pixel_width: self.grid.cols * 8,
                pixel_height: self.grid.rows * 16,
            })
            .map_err(|e| {
                error!("Failed to open PTY: {}", e);
                format!("PTY open error: {}", e)
            })?;

        let mut cmd = CommandBuilder::new(&self.shell);
        cmd.env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV);
        cmd.env_remove(crate::settings::secrets::GROQ_API_KEY_ENV);
        let launch_cwd = self
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .map_err(|_| "Terminal CWD lock poisoned".to_string())?;
        cmd.cwd(&launch_cwd);
        // The host process may be launched by Codex with NO_COLOR=1. The PTY
        // is an ANSI-capable xterm surface, so do not let that launcher hint
        // disable colors for Codex or other interactive terminal programs.
        cmd.env_remove("NO_COLOR");
        cmd.env("TERM", "xterm-256color");
        cmd.env("TRAFLIX_TERMINAL_ID", &self.id);
        cmd.env("TRAFLIX_AGENT_EVENT_PIPE", agent_event_pipe_name());
        cmd.env(
            "TRAFLIX_AGENT_EVENT_PROTOCOL",
            AGENT_EVENT_PROTOCOL.to_string(),
        );
        cmd.env("TRAFLIX_TERMINAL_GENERATION", self.generation.to_string());
        if let Some(bridge_path) = resolve_agent_bridge_path(&app) {
            let bridge_str = bridge_path.to_string_lossy().to_string();
            // Strip the Windows extended-length prefix (\\?\ and \\?\UNC\)
            // that resource_dir() may produce, otherwise `powershell -File`
            // cannot invoke the bridge.
            let clean = if let Some(rest) = bridge_str.strip_prefix(r"\\?\UNC\") {
                format!("\\\\{}", rest)
            } else if let Some(rest) = bridge_str.strip_prefix(r"\\?\") {
                rest.to_string()
            } else {
                bridge_str
            };
            cmd.env("TRAFLIX_AGENT_EVENT_BRIDGE", clean);
        }
        if let Some(workspace_id) = &self.workspace_id {
            cmd.env("TRAFLIX_WORKSPACE_ID", workspace_id);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            error!("Failed to spawn shell: {}", e);
            format!("Shell spawn error: {}", e)
        })?;

        let child_killer = child.clone_killer();
        self.process_id = child.process_id();

        let reader = pair.master.try_clone_reader().map_err(|e| {
            error!("Failed to get PTY reader: {}", e);
            format!("PTY reader error: {}", e)
        })?;

        let writer = pair.master.take_writer().map_err(|e| {
            error!("Failed to get PTY writer: {}", e);
            format!("PTY writer error: {}", e)
        })?;

        let child_arc = Arc::new(Mutex::new(child));
        let reader_arc = Arc::new(Mutex::new(reader));
        self.child = Some(child_arc.clone());
        self.pty = Some(Arc::new(Mutex::new(child_killer)));
        self.master = Some(Arc::new(Mutex::new(pair.master)));
        self.reader = Some(reader_arc.clone());
        self.writer = Some(Arc::new(Mutex::new(writer)));
        self.process_alive.store(true, Ordering::Release);

        let app_reader = app.clone();
        let app_watch = app.clone();
        let parser = self.parser.clone();
        // Arc<str> avoids allocating a new String on every terminal-output emit.
        let id: Arc<str> = Arc::from(self.id.as_str());
        let stop = self.reader_stop.clone();
        let exit_emitted_reader = self.exit_emitted.clone();
        let process_alive_reader = self.process_alive.clone();
        let output_sequence_reader = self.output_sequence.clone();
        let child_for_reader = child_arc.clone();
        let process_exit_code_reader = self.process_exit_code.clone();
        let process_exit_code_watch = self.process_exit_code.clone();
        let registry_workspace_id = self.workspace_id.clone().unwrap_or_default();
        let registry_is_agent_terminal = self.is_agent_terminal;
        let registry_agent_id = self.agent_id.clone();
        let registry_agent_alias = self.agent_alias.clone();
        let registry_generation = self.generation;
        let registry_process_id = self.process_id;

        // PTY reader thread — exits on stop flag, EOF, or after master is dropped.
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 32768];
            let mut natural_exit = false;
            // Output-driven `lastActivityAt` updates are throttled to at most
            // one per second so PTY chunks never touch the registry per chunk.
            let mut last_output_observe: Option<std::time::Instant> = None;

            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let n = {
                    let mut reader = match reader_arc.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    match reader.read(&mut buf) {
                        Ok(n) if n > 0 => n,
                        Ok(0) => {
                            natural_exit = true;
                            info!(terminal_id = %id, "PTY read EOF");
                            break;
                        }
                        Ok(_) => continue,
                        Err(e) => {
                            // ConPTY: broken pipe is normal when the child exits.
                            // Also expected after kill() drops the master handle.
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            natural_exit = true;
                            warn!(terminal_id = %id, error = %e, "PTY read error (treating as EOF)");
                            break;
                        }
                    }
                };

                // Clone only the valid slice once for both parser + emit.
                let data = buf[..n].to_vec();

                let sequence = if let Ok(mut p) = parser.lock() {
                    p.process(&data);
                    output_sequence_reader.fetch_add(1, Ordering::AcqRel) + 1
                } else {
                    output_sequence_reader.fetch_add(1, Ordering::AcqRel) + 1
                };

                let _ = app_reader.emit(
                    "terminal-output",
                    TerminalOutput {
                        terminal_id: id.to_string(),
                        workspace_id: registry_workspace_id.clone(),
                        generation: registry_generation,
                        process_id: registry_process_id,
                        data,
                        sequence,
                    },
                );

                if registry_is_agent_terminal {
                    let due = last_output_observe.map_or(true, |instant| {
                        instant.elapsed() >= std::time::Duration::from_secs(1)
                    });
                    if due {
                        last_output_observe = Some(std::time::Instant::now());
                        if let Some(state) = app_reader.try_state::<crate::jarvis::JarvisState>() {
                            state.registry.observe_output(
                                &id,
                                registry_generation,
                                &chrono::Utc::now().to_rfc3339(),
                            );
                        }
                    }
                }
            }

            if natural_exit {
                process_alive_reader.store(false, Ordering::Release);
                crate::terminal_engine::notify_agent_exit(
                    &app_reader,
                    &TerminalAgentSnapshot {
                        terminal_id: id.to_string(),
                        workspace_id: registry_workspace_id.clone(),
                        is_agent_terminal: registry_is_agent_terminal,
                        agent_id: registry_agent_id.clone(),
                        agent_alias: registry_agent_alias.clone(),
                        observed_provider: None,
                        detection_source: "fallback".to_string(),
                        detection_confidence: 0.2,
                        identity_warnings: Vec::new(),
                        generation: registry_generation,
                        process_id: registry_process_id,
                        process_alive: false,
                        agent_process_alive: None,
                    },
                );
            }

            // Explicitly drop reader so the OS handle is released even if the
            // session-side Arc was already cleared by kill().
            drop(reader_arc);

            info!(terminal_id = %id, "PTY reader task ended");

            if natural_exit && !stop.load(Ordering::Acquire) {
                let exit_code = collect_exit_code(&child_for_reader, &process_exit_code_reader);
                if exit_emitted_reader
                    .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                    .is_ok()
                {
                    let _ = app_reader.emit(
                        "terminal-exited",
                        TerminalExited {
                            terminal_id: id.to_string(),
                            workspace_id: registry_workspace_id.clone(),
                            generation: registry_generation,
                            process_id: registry_process_id,
                            exit_code,
                        },
                    );
                }
            }
        });

        // Child-process watch thread (fallback when reader misses EOF on ConPTY).
        let watch_id: Arc<str> = Arc::from(self.id.as_str());
        let watch_stop = self.reader_stop.clone();
        let watch_child = child_arc;
        let exit_emitted_watch = self.exit_emitted.clone();
        let process_alive_watch = self.process_alive.clone();
        let registry_workspace_id_watch = self.workspace_id.clone().unwrap_or_default();
        let registry_is_agent_terminal_watch = self.is_agent_terminal;
        let registry_agent_id_watch = self.agent_id.clone();
        let registry_agent_alias_watch = self.agent_alias.clone();
        let registry_generation_watch = self.generation;
        let registry_process_id_watch = self.process_id;
        tokio::task::spawn_blocking(move || loop {
            if watch_stop.load(Ordering::Acquire) {
                return;
            }

            let exited = {
                let mut c = match watch_child.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                match c.try_wait() {
                    Ok(Some(status)) => {
                        process_exit_code_watch.store(status.exit_code() as i32, Ordering::Release);
                        true
                    }
                    Ok(None) => false,
                    Err(_) => true,
                }
            };

            if exited {
                process_alive_watch.store(false, Ordering::Release);
                crate::terminal_engine::notify_agent_exit(
                    &app_watch,
                    &TerminalAgentSnapshot {
                        terminal_id: watch_id.to_string(),
                        workspace_id: registry_workspace_id_watch.clone(),
                        is_agent_terminal: registry_is_agent_terminal_watch,
                        agent_id: registry_agent_id_watch.clone(),
                        agent_alias: registry_agent_alias_watch.clone(),
                        observed_provider: None,
                        detection_source: "fallback".to_string(),
                        detection_confidence: 0.2,
                        identity_warnings: Vec::new(),
                        generation: registry_generation_watch,
                        process_id: registry_process_id_watch,
                        process_alive: false,
                        agent_process_alive: None,
                    },
                );
                info!(terminal_id = %watch_id, "Child process exited (watch thread)");
                if !watch_stop.load(Ordering::Acquire)
                    && exit_emitted_watch
                        .compare_exchange(false, true, Ordering::Release, Ordering::Relaxed)
                        .is_ok()
                {
                    let _ = app_watch.emit(
                        "terminal-exited",
                        TerminalExited {
                            terminal_id: watch_id.to_string(),
                            workspace_id: registry_workspace_id_watch.clone(),
                            generation: registry_generation_watch,
                            process_id: registry_process_id_watch,
                            exit_code: process_exit_code_watch.load(Ordering::Acquire).max(0),
                        },
                    );
                }
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(250));
        });

        info!(terminal_id = %self.id, shell = %self.shell, "Shell spawned successfully");
        Ok(())
    }
    pub fn kill(&mut self) -> Result<(), String> {
        // Do not tear down the session until the OS accepted termination. A
        // failed ChildKiller call must leave all handles and liveness state in
        // place so the manager can reinsert the exact session and let the user
        // retry, instead of reporting a false successful close.
        if self.process_alive.load(Ordering::Acquire) {
            // portable-pty kills the shell, but a running cargo/rustc/node
            // descendant can outlive that direct child. On Windows terminate
            // the complete process tree first; the PTY killer below remains the
            // cross-platform fallback and still owns the normal cleanup path.
            #[cfg(windows)]
            if let Some(process_id) = self.process_id {
                terminate_process_tree(process_id);
            }

            let kill_result = self
                .pty
                .as_ref()
                .ok_or_else(|| "PTY child killer unavailable".to_string())
                .and_then(|pty| {
                    let mut killer = pty
                        .lock()
                        .map_err(|_| "PTY child killer lock poisoned".to_string())?;
                    killer
                        .kill()
                        .map_err(|error| format!("PTY child kill failed: {error}"))
                });

            if let Err(kill_error) = kill_result {
                // A process can exit naturally just before kill reaches the
                // OS. Treat that case as success, but never hide a live child
                // or a failed liveness check. Give taskkill/ConPTY a bounded
                // window to publish the exit before declaring the close failed.
                let observed_exit = match self.child.as_ref() {
                    Some(child) => wait_for_child_exit(child, &self.process_exit_code)
                        .map_err(|error| format!("{kill_error}; {error}"))?,
                    None => false,
                };
                if !observed_exit {
                    return Err(kill_error);
                }
            }
        }

        // 1. Signal reader + watch threads (Acquire/Release pairing with loads).
        self.reader_stop.store(true, Ordering::Release);
        self.process_alive.store(false, Ordering::Release);

        // 2. Suppress exit events for a manager-owned close. If the watcher
        // won a genuine exit race before this point, its event remains valid.
        self.exit_emitted.store(true, Ordering::Release);

        // 3. Drop writer so the child sees EOF on stdin.
        self.writer = None;

        // 4. Best-effort reap after a successful kill/natural exit. Failure at
        // this point is diagnostic only: termination was already confirmed or
        // accepted by the OS and retaining a dead session cannot improve it.
        if let Some(ref child) = self.child {
            if let Ok(mut c) = child.lock() {
                let _ = c.try_wait();
            }
        }

        // 5. Drop master PTY — closes the pair and unblocks a blocking
        //    reader.read() so the spawn_blocking reader task can finish.
        self.master = None;
        self.pty = None;
        self.reader = None;
        self.child = None;

        // 6. Free scrollback/screen buffers held by a lingering Arc session.
        let cols = self.grid.cols.max(1);
        let rows = self.grid.rows.max(1);
        self.grid = GridBuffer::new(cols, rows);
        if let Ok(mut p) = self.parser.lock() {
            *p = AnsiParser::new(cols, rows);
        }

        info!(terminal_id = %self.id, "Terminal session cleaned up");
        Ok(())
    }
}

#[cfg(windows)]
fn terminate_process_tree(process_id: u32) -> bool {
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    match command.status() {
        Ok(status) if status.success() => true,
        Ok(status) => {
            warn!(
                process_id,
                exit_code = ?status.code(),
                "Process-tree termination command returned a failure"
            );
            false
        }
        Err(error) => {
            warn!(process_id, error = %error, "Process-tree termination command could not start");
            false
        }
    }
}

fn wait_for_child_exit(
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    shared: &AtomicI32,
) -> Result<bool, String> {
    for _ in 0..20 {
        let status = {
            let mut child = child
                .lock()
                .map_err(|_| "child lock poisoned".to_string())?;
            child
                .try_wait()
                .map_err(|error| format!("child liveness check failed: {error}"))?
        };
        if let Some(status) = status {
            shared.store(status.exit_code() as i32, Ordering::Release);
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(false)
}

fn collect_exit_code(
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    shared: &AtomicI32,
) -> i32 {
    for _ in 0..20 {
        if let Ok(mut child) = child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                let code = status.exit_code() as i32;
                shared.store(code, Ordering::Release);
                return code.max(0);
            }
        }
        let known = shared.load(Ordering::Acquire);
        if known >= 0 {
            return known;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    shared.load(Ordering::Acquire).max(0)
}

fn resolve_agent_bridge_path(app: &AppHandle) -> Option<PathBuf> {
    let configured = std::env::var_os("TRAFLIX_AGENT_EVENT_BRIDGE").map(PathBuf::from);
    let resource = app.path().resource_dir().ok().map(|path| {
        path.join("agent-notifications")
            .join("traflix-agent-event.ps1")
    });
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("agent-notifications")
        .join("traflix-agent-event.ps1");

    [configured, resource, Some(development)]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}
