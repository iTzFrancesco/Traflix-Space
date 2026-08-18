use super::*;

impl TerminalManager {
    pub fn start_event_loop(&self, app: AppHandle) {
        info!("Terminal manager event loop ready");
        if self
            .detector_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        #[cfg(windows)]
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(manager) = app.try_state::<TerminalManager>() else {
                    info!("Terminal process detector stopped: application state unavailable");
                    break;
                };
                let targets = manager.process_detection_targets().await;
                let root_pids = targets
                    .iter()
                    .map(|(_, _, pid, _)| *pid)
                    .collect::<Vec<_>>();
                match scan_process_tree_async(root_pids).await {
                    Ok(scan) => {
                        manager.apply_process_detections(targets, scan, &app).await;
                    }
                    Err(error) => {
                        warn!(%error, "Agent process-tree scan unavailable; liveness unchanged");
                    }
                }
                let retry_fast = manager
                    .process_detection_targets()
                    .await
                    .iter()
                    .any(|(_, _, _, source)| identity_source_priority(source) < 4);
                tokio::time::sleep(std::time::Duration::from_secs(if retry_fast {
                    3
                } else {
                    10
                }))
                .await;
            }
        });

        #[cfg(not(windows))]
        {
            let _ = app;
        }
    }

    #[cfg(windows)]
    async fn process_detection_targets(&self) -> Vec<(String, u64, u32, String)> {
        let sessions = self
            .sessions
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let mut targets = Vec::new();
        for session in sessions {
            let session = session.read().await;
            if !session.process_alive.load(Ordering::Acquire)
                || session.process_id.is_none()
                || (!session.is_agent_terminal
                    && session.agent_id.is_none()
                    && session.observed_provider.is_none()
                    && session.agent_runtime_presence.alive().is_none())
            {
                continue;
            }
            targets.push((
                session.id.clone(),
                session.generation,
                session.process_id.unwrap_or_default(),
                session.detection_source.clone(),
            ));
        }
        targets
    }

    #[cfg(windows)]
    pub(super) async fn apply_process_detections(
        &self,
        targets: Vec<(String, u64, u32, String)>,
        scan: crate::jarvis::runtime_detector::ProcessTreeScan,
        app: &AppHandle,
    ) {
        for (terminal_id, generation, pid, _) in targets {
            let Some(session_arc) = self
                .sessions
                .get(&terminal_id)
                .map(|entry| entry.value().clone())
            else {
                continue;
            };
            let mut session = session_arc.write().await;
            let current = self
                .sessions
                .get(&terminal_id)
                .map(|entry| Arc::ptr_eq(entry.value(), &session_arc))
                .unwrap_or(false);
            if session.generation == generation
                && session.process_id == Some(pid)
                && session.process_alive.load(Ordering::Acquire)
                && current
            {
                if let Some(detection) = scan.detections.get(&pid) {
                    let presence_transition = session.agent_runtime_presence.observed();
                    let identity_changed = session.observed_provider.as_deref()
                        != Some(detection.provider.as_str())
                        || session.detection_source != detection.source
                        || !session.is_agent_terminal;
                    apply_runtime_identity(&mut session, detection);
                    if presence_transition == AgentPresenceTransition::BecameActive
                        || identity_changed
                    {
                        let snapshot = snapshot_from_session(&session);
                        drop(session);
                        notify_agent_started(app, &snapshot);
                    }
                } else if scan.roots_with_candidate_descendants.contains(&pid) {
                    if let Some(provider) = candidate_descendant_provider(&session) {
                        let transition = session.agent_runtime_presence.observed();
                        if transition == AgentPresenceTransition::BecameActive {
                            apply_runtime_identity(
                                &mut session,
                                &AgentDetection {
                                    provider,
                                    source: "process-tree".to_string(),
                                    confidence: 0.9,
                                },
                            );
                            let snapshot = snapshot_from_session(&session);
                            drop(session);
                            notify_agent_started(app, &snapshot);
                        }
                    }
                } else if session.agent_runtime_presence.missed()
                    == AgentPresenceTransition::BecameInactive
                {
                    session.is_agent_terminal = false;
                    session.observed_provider = None;
                    session.backend_agent_launch_state = None;
                    session.detection_source = "agent-process-exited".to_string();
                    session.detection_confidence = 0.9;
                    let snapshot = snapshot_from_session(&session);
                    drop(session);
                    notify_agent_exit(app, &snapshot);
                }
            }
        }
    }

    #[allow(dead_code)]
    pub async fn start_frame_scheduler(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        self.scheduler
            .lock()
            .await
            .start(app, session, id.to_string())
            .await;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn stop_frame_scheduler(&self, id: &str) {
        self.scheduler.lock().await.stop(id);
    }
}
