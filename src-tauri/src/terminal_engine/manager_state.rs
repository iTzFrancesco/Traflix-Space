use super::*;

impl TerminalManager {
    pub async fn set_active(&self, app: &AppHandle, id: Option<&str>) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        // Validate and recover the target before changing either active marker.
        // A failed spawn must leave the previous terminal active.
        if let Some(new_id) = id {
            if !self.sessions.contains_key(new_id) {
                return Err(format!("Terminal {} not found", new_id));
            }
            self.spawn_shell(app, new_id).await?;
        }

        let mut active = self.active_id.lock().await;
        if active.as_deref() == id {
            return Ok(());
        }
        let prev = active.clone();
        *active = id.map(str::to_owned);
        drop(active);

        if let Some(prev_id) = prev {
            if Some(prev_id.as_str()) != id {
                if let Some(session) = self
                    .sessions
                    .get(&prev_id)
                    .map(|entry| entry.value().clone())
                {
                    session.write().await.active = false;
                }
            }
        }
        if let Some(new_id) = id {
            if let Some(session) = self.sessions.get(new_id).map(|entry| entry.value().clone()) {
                session.write().await.active = true;
            }
        }

        info!(terminal_id = ?id, "Active terminal set");
        Ok(())
    }

    /// Activate only the exact PTY lifetime named by the frontend. The
    /// identity is rechecked while the target session is locked so a delayed
    /// focus callback cannot activate a replacement that reused the same id.
    pub async fn set_active_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
    ) -> Result<(), String> {
        let _lifecycle = self.workspace_lifecycle.lock().await;
        let target = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        {
            let mut session = target.write().await;
            if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
                || session.generation != generation
                || session.process_id != process_id
            {
                return Err("stale-terminal-generation: active target changed".to_string());
            }
            let current = self
                .sessions
                .get(id)
                .map(|entry| Arc::ptr_eq(entry.value(), &target))
                .unwrap_or(false);
            if !current {
                return Err("stale-terminal-generation: session was replaced".to_string());
            }
            if !session.process_alive.load(Ordering::Acquire) {
                return Err(format!("terminal-exited: {id}"));
            }
            session.active = true;
        }

        let mut active = self.active_id.lock().await;
        if active.as_deref() == Some(id) {
            return Ok(());
        }
        let previous = active.replace(id.to_string());
        drop(active);
        if let Some(previous_id) = previous.filter(|previous_id| previous_id != id) {
            if let Some(session) = self
                .sessions
                .get(&previous_id)
                .map(|entry| entry.value().clone())
            {
                session.write().await.active = false;
            }
        }
        info!(terminal_id = %id, generation, process_id = ?process_id, "Active terminal lifetime set");
        Ok(())
    }

    /// Formatted scrollback, visible screen, parser modes, geometry, and the
    /// output watermark for rehydrating xterm after a workspace switch while
    /// the PTY remains alive.
    pub async fn get_state_for_rehydrate(
        &self,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: Option<u64>,
        expected_process_id: Option<u32>,
    ) -> Result<TerminalRehydrateState, String> {
        self.validate_rehydrate_scope(
            id,
            expected_workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await?;
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;

        let session = session_arc.read().await;
        if let Some(expected_generation) = expected_generation {
            if session.generation != expected_generation {
                return Err(format!(
                    "stale-terminal-generation: expected {}, current {}",
                    expected_generation, session.generation
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

        let mut parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let history = parser.scrollback_text_for_rehydrate();
        let state = parser.state_for_rehydrate();
        let output_sequence = session.output_sequence.load(Ordering::Acquire);
        Ok(TerminalRehydrateState {
            workspace_id: session.workspace_id.clone().unwrap_or_default(),
            generation: session.generation,
            process_id: session.process_id,
            history,
            state,
            output_sequence,
            cols: session.grid.cols,
            rows: session.grid.rows,
        })
    }

    pub async fn get_agent_snapshot(
        &self,
        id: &str,
    ) -> Result<Option<TerminalAgentSnapshot>, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(Some(snapshot_from_session(&session)))
    }

    /// Refresh the provider-child presence for one exact PTY lifetime before
    /// a Jarvis prompt is written. The shell can remain alive after Codex (or
    /// another provider) exits, so a shell-only liveness check is insufficient
    /// for safe automatic reactivation.
    pub async fn refresh_agent_process_presence(
        &self,
        app: &AppHandle,
        id: &str,
        expected_workspace_id: &str,
        expected_generation: u64,
        expected_process_id: Option<u32>,
    ) -> Result<Option<bool>, String> {
        self.validate_runtime_identity(
            id,
            expected_workspace_id,
            expected_generation,
            expected_process_id,
        )
        .await?;

        #[cfg(windows)]
        if let Some(process_id) = expected_process_id {
            let source = self
                .sessions
                .get(id)
                .map(|entry| entry.value().clone())
                .ok_or_else(|| format!("Terminal {id} not found"))?;
            let source = source.read().await.detection_source.clone();
            let scan = scan_process_tree_async(vec![process_id]).await?;
            self.apply_process_detections(
                vec![(id.to_string(), expected_generation, process_id, source)],
                scan,
                app,
            )
            .await;
        }

        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {id} not found"))?;
        let session = session.read().await;
        if session.workspace_id.as_deref().unwrap_or_default() != expected_workspace_id
            || session.generation != expected_generation
            || session.process_id != expected_process_id
        {
            return Err("stale-terminal-generation: provider target changed".to_string());
        }
        Ok(session.agent_runtime_presence.alive())
    }

    pub async fn observe_agent_provider_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        provider: &str,
        source: &str,
        confidence: f32,
    ) -> Result<(), String> {
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let mut session = session_arc.write().await;
        if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
            || session.generation != generation
            || session.process_id != process_id
        {
            return Err("stale-terminal-generation: provider target changed".to_string());
        }
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        apply_observed_provider(&mut session, provider, source, confidence);
        Ok(())
    }

    pub async fn get_recent_normalized_terminal_text_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        max_bytes: usize,
    ) -> Result<NormalizedTerminalText, String> {
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let session = session_arc.read().await;
        let mut parser = session
            .parser
            .lock()
            .map_err(|_| format!("Terminal {} parser lock poisoned", id))?;
        let text = parser.recent_normalized_text();
        drop(parser);
        let current = self
            .sessions
            .get(id)
            .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
            .unwrap_or(false);
        if !current {
            return Err("stale-terminal-generation: session was replaced".to_string());
        }
        bounded_terminal_text(&text, max_bytes)
    }

    pub async fn list_agent_snapshots(&self) -> Vec<TerminalAgentSnapshot> {
        let sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut snapshots = Vec::new();
        for session in sessions {
            let session = session.read().await;
            if session.is_agent_terminal {
                snapshots.push(snapshot_from_session(&session));
            }
        }
        snapshots.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
        snapshots
    }

    pub async fn get_snapshot(
        &self,
        id: &str,
        expected_generation: u64,
    ) -> Result<FrameSnapshot, String> {
        let session_arc = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session_arc.read().await;
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

        let rows = session.grid.rows;
        let cols = session.grid.cols;
        let mut cells = Vec::new();

        if let Ok(p) = session.parser.lock() {
            let screen = p.screen();
            for r in 0..rows {
                let mut row = Vec::new();
                for c in 0..cols {
                    if let Some(vt_cell) = screen.cell(r, c) {
                        row.push(convert_vt_cell(vt_cell));
                    } else {
                        row.push(Cell::default());
                    }
                }
                cells.push(row);
            }
        } else {
            for _ in 0..rows {
                let mut row = Vec::new();
                for _ in 0..cols {
                    row.push(Cell::default());
                }
                cells.push(row);
            }
        }

        let cursor_pos = if let Ok(p) = session.parser.lock() {
            let (cr, cc) = p.screen().cursor_position();
            crate::terminal_engine::frame::CursorPosition { row: cr, col: cc }
        } else {
            session.grid.cursor.clone()
        };

        let title = if let Ok(p) = session.parser.lock() {
            p.screen().title().to_string()
        } else {
            session.grid.title.clone()
        };

        Ok(FrameSnapshot {
            terminal_id: id.to_string(),
            cols,
            rows,
            cells,
            cursor: cursor_pos,
            cursor_visible: true,
            title,
        })
    }

    pub async fn get_scrollback(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<Vec<Cell>>, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        Ok(session.grid.get_scrollback(offset, limit))
    }

    /// Returns the current git branch name for the terminal's working directory.
    /// Runs `git -C <cwd> branch --show-current` and returns Some(branch) if
    /// the directory is a git repository, or None otherwise.
    /// Errors only if the terminal session doesn't exist.
    pub async fn get_git_branch(&self, id: &str) -> Result<Option<String>, String> {
        let cwd = self.get_terminal_cwd(id).await?;
        self.get_git_branch_for_cwd(id, &cwd).await
    }

    /// Returns a CWD and its branch from the same backend snapshot.
    pub async fn get_terminal_context_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
    ) -> Result<TerminalContext, String> {
        let session = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        let cwd = {
            let session = session.read().await;
            session
                .cwd
                .lock()
                .map(|cwd| cwd.clone())
                .map_err(|_| format!("Terminal {} CWD lock poisoned", id))?
        };
        let git_branch = self.get_git_branch_for_cwd(id, &cwd).await?;
        self.session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        Ok(TerminalContext { cwd, git_branch })
    }

    /// Synchronizes the tracked CWD with the shell prompt rendered in xterm.
    /// This covers PowerShell tab completion, whose completed path never passes
    /// back through the PTY input stream as literal keystrokes.
    pub async fn sync_terminal_cwd_for_runtime(
        &self,
        id: &str,
        workspace_id: &str,
        generation: u64,
        process_id: Option<u32>,
        cwd: &str,
    ) -> Result<TerminalContext, String> {
        let canonical = std::path::Path::new(cwd)
            .canonicalize()
            .map_err(|error| format!("Could not resolve terminal CWD: {error}"))?;
        if !canonical.is_dir() {
            return Err("Terminal CWD is not a directory".to_string());
        }
        let normalized = canonical
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .trim_start_matches("\\\\.\\")
            .to_string();
        let session_arc = self
            .session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        {
            let session = session_arc.read().await;
            if session.workspace_id.as_deref().unwrap_or_default() != workspace_id
                || session.generation != generation
                || session.process_id != process_id
            {
                return Err("stale-terminal-generation: CWD target changed".to_string());
            }
            let current_session = self
                .sessions
                .get(id)
                .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
                .unwrap_or(false);
            if !current_session {
                return Err("stale-terminal-generation: session was replaced".to_string());
            }
            let mut current = session
                .cwd
                .lock()
                .map_err(|_| format!("Terminal {} CWD lock poisoned", id))?;
            if *current != normalized {
                info!(terminal_id = %id, generation, from = %current, to = %normalized, "Terminal CWD synchronized from exact PowerShell runtime");
                *current = normalized.clone();
            }
        }
        let git_branch = self.get_git_branch_for_cwd(id, &normalized).await?;
        self.session_for_runtime(id, workspace_id, generation, process_id)
            .await?;
        Ok(TerminalContext {
            cwd: normalized,
            git_branch,
        })
    }

    async fn get_terminal_cwd(&self, id: &str) -> Result<String, String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        let session = session.read().await;
        session
            .cwd
            .lock()
            .map(|cwd| cwd.clone())
            .map_err(|_| format!("Terminal {} CWD lock poisoned", id))
    }

    async fn get_git_branch_for_cwd(&self, id: &str, cwd: &str) -> Result<Option<String>, String> {
        info!(terminal_id = %id, cwd = %cwd, "get_git_branch: checking");

        let mut git_command = tokio::process::Command::new("git");
        git_command
            .args(["-C", cwd, "branch", "--show-current"])
            // This probe must never inherit an interactive terminal: it is a
            // metadata lookup for the title bar, not a user-facing command.
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .env_remove(crate::settings::secrets::OPENCODE_ZEN_API_KEY_ENV)
            .env_remove(crate::settings::secrets::GROQ_API_KEY_ENV)
            .env("GIT_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never");

        // The release app is a Windows GUI process without a console. Without
        // CREATE_NO_WINDOW, every background `git` probe can create a visible
        // console window when the user changes directory or workspace.
        #[cfg(windows)]
        git_command.creation_flags(0x08000000);

        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), git_command.output()).await;

        let output = match result {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                info!(terminal_id = %id, cwd = %cwd, error = %e, "get_git_branch: spawn error");
                return Ok(None);
            }
            Err(_) => {
                info!(terminal_id = %id, cwd = %cwd, "get_git_branch: timed out after 5s");
                return Ok(None);
            }
        };

        if output.status.success() {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            info!(
                terminal_id = %id,
                cwd = %cwd,
                branch = %branch,
                "get_git_branch: success"
            );
            Ok(if branch.is_empty() {
                None
            } else {
                Some(branch)
            })
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            info!(
                terminal_id = %id,
                cwd = %cwd,
                git_exit = %output.status,
                git_stderr = %stderr,
                "get_git_branch: git failed"
            );
            Ok(None)
        }
    }
}
