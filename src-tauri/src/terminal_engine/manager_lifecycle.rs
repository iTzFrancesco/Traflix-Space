use super::*;

impl TerminalManager {
    pub fn new() -> Self {
        // Persisted terminal ids survive app restarts. Seed the lifetime token
        // from wall-clock microseconds so a late hook/event from the previous
        // Traflix process cannot collide with generation 1 in the new process.
        // Microseconds remain exact in JavaScript's Number representation.
        let generation_seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_micros().min(9_007_199_254_740_990_u128) as u64)
            .unwrap_or(1);
        Self {
            sessions: DashMap::new(),
            scheduler: tokio::sync::Mutex::new(FrameScheduler::new()),
            active_id: tokio::sync::Mutex::new(None),
            workspace_lifecycle: tokio::sync::Mutex::new(()),
            closing_workspaces: DashSet::new(),
            next_generation: AtomicU64::new(generation_seed),
            detector_started: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub async fn spawn(
        &self,
        app: AppHandle,
        config: crate::workspace::registry::TerminalConfig,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let id = config.id.clone();
        let initial_cols = cols.max(MIN_TERMINAL_COLS);
        let initial_rows = rows.max(MIN_TERMINAL_ROWS);
        let workspace_id = config.workspace_id.clone().unwrap_or_default();
        let lifecycle = self.workspace_lifecycle.lock().await;
        self.ensure_workspace_accepts_spawns(&workspace_id)?;

        // Reuse a live PTY. If it exited while the frontend was unmounted,
        // report that state instead of silently replacing an agent session
        // with a fresh shell; `terminal_reopen` is the explicit restart path.
        loop {
            if let Some(entry) = self.sessions.get(&id) {
                let session = entry.value().clone();
                drop(entry);
                let session_state = session.read().await;
                let process_alive = session_state.process_alive.load(Ordering::Acquire);
                let spawn_in_progress = session_state.pty.is_none();
                ensure_spawn_workspace_matches(
                    session_state.workspace_id.as_deref(),
                    &workspace_id,
                )?;
                drop(session_state);

                if process_alive || spawn_in_progress {
                    info!(terminal_id = %id, "Terminal session already exists, reusing");
                    // The existing PTY owns the live TUI geometry. The
                    // frontend synchronizes the measured DOM size after
                    // layout; resizing here would force a freshly mounted
                    // xterm's default 80x24 onto a running TUI.
                    if let Ok(Some(snapshot)) = self.get_agent_snapshot(&id).await {
                        if snapshot.is_agent_terminal {
                            notify_agent_started(&app, &snapshot);
                        }
                    }
                    return Ok(id);
                }

                info!(terminal_id = %id, "Terminal session already exited");
                return Err(format!("terminal-exited: {}", id));
            }

            // Atomic check-or-insert. If another caller inserts between the
            // lookup and this entry operation, loop and inspect its state.
            match self.sessions.entry(id.clone()) {
                Entry::Occupied(entry) => {
                    drop(entry);
                    continue;
                }
                Entry::Vacant(slot) => {
                    let shell = if config.shell.is_empty() {
                        "powershell.exe".to_string()
                    } else {
                        config.shell.clone()
                    };
                    let cwd_raw = if config.cwd.is_empty() {
                        std::env::current_dir()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| ".".to_string())
                    } else {
                        config.cwd.clone()
                    };
                    // Strip Windows extended-length prefixes that break some shells.
                    let cwd = cwd_raw
                        .trim_start_matches("\\\\?\\")
                        .trim_start_matches("\\\\.\\")
                        .to_string();

                    let generation = self.next_generation.fetch_add(1, Ordering::AcqRel);
                    let mut session = TerminalSession::new(
                        id.clone(),
                        if config.title.trim().is_empty() {
                            "Terminal".to_string()
                        } else {
                            config.title.clone()
                        },
                        shell,
                        cwd,
                        initial_cols,
                        initial_rows,
                    );
                    session.generation = generation;
                    session.is_agent_terminal = config.agent_id.is_some();
                    session.agent_id = config.agent_id.clone();
                    session.agent_alias = config.agent_alias.clone();
                    if session.agent_id.is_some() {
                        session.detection_source = "configured-hint".to_string();
                        session.detection_confidence = 0.65;
                    }
                    session.workspace_id = config.workspace_id.clone();
                    slot.insert(Arc::new(RwLock::new(session)));
                    info!(terminal_id = %id, "Terminal session created");
                    break;
                }
            }
        }
        // Spawn the shell immediately so the PTY reader starts sending output.
        // Keep the lifecycle barrier through this cutover: otherwise an exact
        // close can remove the map entry while spawn_shell still owns its Arc,
        // allowing an untracked child process to be created after removal.
        if let Err(e) = self.spawn_shell(&app, &id).await {
            let _ = self.sessions.remove(&id);
            return Err(e);
        }
        drop(lifecycle);

        if let Some(snapshot) = self.get_agent_snapshot(&id).await.ok().flatten() {
            if snapshot.is_agent_terminal {
                notify_agent_started(&app, &snapshot);
            }
        }

        Ok(id)
    }

    pub async fn spawn_shell(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was removed before spawn".to_string());
        }
        if session.pty.is_some() {
            if session.process_alive.load(Ordering::Acquire) {
                return Ok(());
            }
            return Err(format!("terminal-exited: {}", id));
        }
        if session.process_id.is_some() && !session.process_alive.load(Ordering::Acquire) {
            return Err(format!("terminal-exited: {}", id));
        }
        session.spawn(app.clone()).await?;
        info!(terminal_id = %id, "Shell spawned");
        Ok(())
    }

    pub async fn runtime_identity(&self, id: &str) -> Result<TerminalRuntimeIdentity, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(TerminalRuntimeIdentity {
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            generation: session.generation,
            process_id: session.process_id,
            agent_launch_owner: session
                .backend_agent_launch_state
                .as_ref()
                .map(|_| "backend".to_string()),
            agent_launch_state: session.backend_agent_launch_state.clone(),
        })
    }

    pub async fn set_backend_agent_launch_state(
        &self,
        id: &str,
        expected: &TerminalRuntimeIdentity,
        launch_state: &str,
    ) -> Result<(), String> {
        if !matches!(launch_state, "starting" | "ready" | "failed") {
            return Err("invalid backend agent launch state".to_string());
        }
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if session.workspace_id.as_deref().unwrap_or_default() != expected.workspace_id.as_str() {
            return Err("stale-terminal-workspace: backend launch session changed".to_string());
        }
        if session.generation != expected.generation {
            return Err("stale-terminal-generation: backend launch session changed".to_string());
        }
        if session.process_id != expected.process_id {
            return Err("stale-terminal-process: backend launch session changed".to_string());
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        session.backend_agent_launch_state = Some(launch_state.to_string());
        Ok(())
    }

    /// Validate all stable coordinates of a PTY lifetime before an IPC-side
    /// mutation. Generation prevents reopen races, process id prevents an
    /// accidental same-generation process substitution, and workspace id
    /// prevents a globally reused terminal id from crossing workspace seams.
    pub async fn validate_runtime_identity(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
        let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
        if workspace_id != expected_workspace_id {
            return Err(format!(
                "stale-terminal-workspace: expected {}, current {}",
                expected_workspace_id, workspace_id
            ));
        }
        if session.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, session.generation
            ));
        }
        if session.process_id != expected_process_id {
            return Err(format!(
                "stale-terminal-process: expected {:?}, current {:?}",
                expected_process_id, session.process_id
            ));
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(())
    }

    pub(super) async fn session_for_runtime(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<Arc<RwLock<TerminalSession>>, String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        {
            let session = session_arc.read().await;
            let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
            if workspace_id != expected_workspace_id {
                return Err(format!(
                    "stale-terminal-workspace: expected {}, current {}",
                    expected_workspace_id, workspace_id
                ));
            }
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(session_arc)
    }

    /// Snapshot discovery still validates workspace. Once generation/process
    /// are known, the caller supplies them and receives the same exact checks
    /// used by mutations.
    pub(super) async fn validate_rehydrate_scope(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: Option<u64>,
        expected_process_id: Option<u32>,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
        let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
        if workspace_id != expected_workspace_id {
            return Err(format!(
                "stale-terminal-workspace: expected {}, current {}",
                expected_workspace_id, workspace_id
            ));
        }
        if let Some(generation) = expected_generation {
            if session.generation != generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        Ok(())
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// Write into the PTY and observe the write according to its origin.
    /// User writes feed the bounded input tracker (a task is registered only
    /// when Enter commits a reliable line); Jarvis writes are registered by
    /// the caller with the exact text after this call succeeds.
    async fn write_typed_inner(
        &self,
        app: &AppHandle,
        id: &str,
        expected_runtime: Option<(&str, u64, Option<u32>)>,
        operation_id: Option<&str>,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if let Some((expected_workspace_id, expected_generation, expected_process_id)) =
            expected_runtime
        {
            let workspace_id = session.workspace_id.as_deref().unwrap_or_default();
            if workspace_id != expected_workspace_id {
                return Err(format!(
                    "stale-terminal-workspace: expected {}, current {}",
                    expected_workspace_id, workspace_id
                ));
            }
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }
            if session.process_id != expected_process_id {
                return Err(format!(
                    "stale-terminal-process: expected {:?}, current {:?}",
                    expected_process_id, session.process_id
                ));
            }
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        if let Some(operation_id) = operation_id {
            if operation_id.is_empty()
                || operation_id.len() > 512
                || !operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b":-_.".contains(&byte))
            {
                return Err("invalid-input-operation-id".to_string());
            }
            if let Some(previous) = session.previous_input_operation(operation_id, data)? {
                return previous;
            }
        }

        if let Err(error) = session.write(data) {
            if let Some(operation_id) = operation_id {
                session.record_input_operation(operation_id.to_string(), data, Err(error.clone()));
            }
            return Err(error);
        }
        if let Some(operation_id) = operation_id {
            session.record_input_operation(operation_id.to_string(), data, Ok(()));
        }
        let command_detections = session.observe_agent_commands(data);
        let mut backend_identity_promoted = false;
        for detection in command_detections {
            let detection = promote_backend_launch_detection(
                origin,
                session.backend_agent_launch_state.as_deref(),
                session.agent_id.as_deref(),
                detection,
            );
            backend_identity_promoted |= detection.source == "backend-launch";
            if detection.source == "backend-launch" {
                apply_backend_launch_identity(&mut session, &detection);
            } else {
                apply_runtime_identity(&mut session, &detection);
            }
        }
        let agent_snapshot = snapshot_from_session(&session);

        // If the CWD was updated by a cd command detection, notify the frontend.
        if session.cwd_changed.swap(false, Ordering::Acquire) {
            let cwd = session
                .cwd
                .lock()
                .map(|cwd| cwd.clone())
                .unwrap_or_default();
            let _ = app.emit(
                "terminal-cwd-changed",
                TerminalCwdChanged {
                    terminal_id: id.to_string(),
                    workspace_id: agent_snapshot.workspace_id.clone(),
                    generation: agent_snapshot.generation,
                    process_id: agent_snapshot.process_id,
                    cwd,
                },
            );
        }

        drop(session);
        if agent_snapshot.is_agent_terminal {
            match origin {
                TerminalInputOrigin::User => notify_agent_user_input(&app, &agent_snapshot, data),
                TerminalInputOrigin::JarvisAbort => {
                    notify_agent_abort(&app, &agent_snapshot);
                }
                TerminalInputOrigin::Internal if backend_identity_promoted => {
                    // Backend-owned launches are authoritative: publish the
                    // trusted identity immediately so a concurrent reconcile
                    // cannot block Jarvis' first prompt on manual confirmation.
                    notify_agent_started(&app, &agent_snapshot);
                }
                TerminalInputOrigin::JarvisPrompt | TerminalInputOrigin::Internal => {
                    // Jarvis tasks are registered by chat.rs only after this
                    // call succeeds, with the exact validated text.
                }
            }
        }
        Ok(())
    }

    pub async fn write_typed_for_generation(
        &self,
        app: &AppHandle,
        id: &str,
        expected_generation: u64,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        let runtime = self.runtime_identity(id).await?;
        if runtime.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, runtime.generation
            ));
        }
        self.write_typed_inner(
            app,
            id,
            Some((
                &runtime.workspace_id,
                expected_generation,
                runtime.process_id,
            )),
            None,
            data,
            origin,
        )
        .await
    }

    pub async fn write_typed_for_runtime(
        &self,
        app: &AppHandle,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
        operation_id: Option<&str>,
        data: &[u8],
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        self.write_typed_inner(
            app,
            id,
            Some((
                expected_workspace_id,
                expected_generation,
                expected_process_id,
            )),
            operation_id,
            data,
            origin,
        )
        .await
    }

    pub async fn resize_generation(
        &self,
        id: &str,
        expected_generation: u64,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let mut session = session_arc.write().await;
        if session.generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, session.generation
            ));
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        session.resize(cols, rows)
    }

    pub async fn kill_generation(
        &self,
        app: &AppHandle,
        id: &str,
        expected_generation: u64,
    ) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        let expected_session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let current_generation = expected_session.read().await.generation;
        if current_generation != expected_generation {
            return Err(format!(
                "stale-terminal-generation: expected {}, current {}",
                expected_generation, current_generation
            ));
        }
        let removed = self
            .sessions
            .remove_if(id, |_, current| Arc::ptr_eq(current, &expected_session))
            .ok_or_else(|| "stale-terminal-generation: session was replaced".to_string())?;
        self.finish_removed_session(app, id, removed.1).await
    }

    /// Close the runtime half of a workspace before its persisted definition is
    /// deleted. The closing marker and session selection share the same short
    /// lifecycle gate as `spawn`, making the cutover deterministic: a spawn is
    /// either selected by this sweep or rejected as `workspace-closing`.
    pub async fn shutdown_workspace(
        &self,
        app: &AppHandle,
        workspace_id: &str,
    ) -> Result<usize, String> {
        let lifecycle = self.workspace_lifecycle.lock().await;
        self.closing_workspaces.insert(workspace_id.to_string());

        let candidates = self
            .sessions
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut removed = Vec::new();
        for (terminal_id, session) in candidates {
            let owns_workspace = session
                .read()
                .await
                .workspace_id
                .as_deref()
                .is_some_and(|candidate| candidate == workspace_id);
            if !owns_workspace {
                continue;
            }
            if let Some((_, session)) = self
                .sessions
                .remove_if(&terminal_id, |_, current| Arc::ptr_eq(current, &session))
            {
                removed.push((terminal_id, session));
            }
        }
        drop(lifecycle);

        let removed_count = removed.len();
        let mut first_error = None;
        for (terminal_id, session) in removed {
            if let Err(error) = self
                .finish_removed_session(app, &terminal_id, session)
                .await
            {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(removed_count),
        }
    }

    /// Commit the persistent half of an exact terminal close while `spawn`
    /// shares this lifecycle gate. A replacement generation that appeared
    /// after `kill_generation` aborts the commit, so an old close can never
    /// remove the configuration that now owns a new PTY lifetime.
    pub async fn commit_terminal_close(
        &self,
        registry: &crate::workspace::registry::WorkspaceRegistry,
        terminal_id: &str,
        workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<crate::workspace::registry::WorkspaceConfig, String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        self.ensure_workspace_accepts_spawns(workspace_id)?;

        if let Some(entry) = self.sessions.get(terminal_id) {
            let session = entry.value().clone();
            drop(entry);
            let session = session.read().await;
            return Err(format!(
                "terminal-close-race: expected generation {expected_generation} process {:?}, current generation {} process {:?}",
                expected_process_id, session.generation, session.process_id,
            ));
        }

        registry
            .remove_terminal_and_save(workspace_id, terminal_id)
            .await?
            .ok_or_else(|| "workspace non disponibile".to_string())
    }

    /// Re-open the spawn gate only when a failed deletion was rolled back or a
    /// workspace with the same explicit id was successfully created again.
    pub fn allow_workspace_spawns(&self, workspace_id: &str) {
        self.closing_workspaces.remove(workspace_id);
    }

    pub(super) fn ensure_workspace_accepts_spawns(&self, workspace_id: &str) -> Result<(), String> {
        if !workspace_id.is_empty() && self.closing_workspaces.contains(workspace_id) {
            return Err(format!("workspace-closing: {workspace_id}"));
        }
        Ok(())
    }

    async fn finish_removed_session(
        &self,
        app: &AppHandle,
        id: &str,
        session_arc: Arc<RwLock<TerminalSession>>,
    ) -> Result<(), String> {
        let mut session = session_arc.write().await;
        let mut agent_snapshot = snapshot_from_session(&session);
        if let Err(error) = session.kill() {
            drop(session);
            let restored = match self.sessions.entry(id.to_string()) {
                Entry::Vacant(entry) => {
                    entry.insert(Arc::clone(&session_arc));
                    true
                }
                Entry::Occupied(entry) => Arc::ptr_eq(entry.get(), &session_arc),
            };
            warn!(
                terminal_id = %id,
                error_code = "terminal-kill-failed",
                restored,
                error = %error,
                "Terminal kill failed; runtime session retained for retry"
            );
            return if restored {
                Err(format!("terminal-kill-failed: {error}"))
            } else {
                Err(format!("terminal-kill-rollback-collision: {error}"))
            };
        }
        agent_snapshot.process_alive = false;
        drop(session);
        self.scheduler.lock().await.stop(id);

        let mut active = self.active_id.lock().await;
        if active.as_deref() == Some(id) {
            *active = None;
        }

        if agent_snapshot.is_agent_terminal {
            notify_agent_exit(app, &agent_snapshot);
        }

        info!(terminal_id = %id, "Terminal killed and removed");
        Ok(())
    }

    /// Kill every live session — used on app exit so no ConPTY/shell orphans remain.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        if ids.is_empty() {
            return;
        }
        info!(
            count = ids.len(),
            "Killing all terminal sessions on shutdown"
        );
        for id in ids {
            if let Some((_, session_arc)) = self.sessions.remove(&id) {
                let mut session = session_arc.write().await;
                if let Err(error) = session.kill() {
                    drop(session);
                    self.sessions.insert(id.clone(), session_arc);
                    warn!(
                        terminal_id = %id,
                        error_code = "terminal-kill-failed",
                        error = %error,
                        "Terminal remained registered after shutdown kill failure"
                    );
                }
            }
            self.scheduler.lock().await.stop(&id);
        }
        *self.active_id.lock().await = None;
        self.scheduler.lock().await.stop_all();
    }
}

pub(crate) fn ensure_spawn_workspace_matches(
    current_workspace_id: Option<&str>,
    requested_workspace_id: &str,
) -> Result<(), String> {
    if current_workspace_id.unwrap_or_default() != requested_workspace_id {
        return Err(
            "terminal-workspace-mismatch: existing PTY belongs to another workspace".into(),
        );
    }
    Ok(())
}
