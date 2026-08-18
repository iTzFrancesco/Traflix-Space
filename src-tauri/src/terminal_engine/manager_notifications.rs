use super::*;

pub(crate) fn notify_agent_started(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_terminal_started(snapshot, &chrono::Utc::now().to_rfc3339());
    }
    emit_agent_registry_changed(app, snapshot, "started");
}

pub(crate) fn notify_agent_user_input(
    app: &AppHandle,
    snapshot: &TerminalAgentSnapshot,
    data: &[u8],
) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        let observed_at = chrono::Utc::now().to_rfc3339();
        state
            .registry
            .observe_user_input(snapshot, data, &observed_at);
        state
            .registry
            .observe_user_typing(snapshot, data, &observed_at);
    }
    // Typing alone does not change the user-visible lifecycle. Refresh only
    // after a committed line to avoid an IPC/context refresh per keystroke.
    if data.iter().any(|byte| matches!(byte, b'\r' | b'\n')) {
        emit_agent_registry_changed(app, snapshot, "input_committed");
    }
}

pub(crate) fn notify_agent_abort(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state
            .registry
            .observe_abort(snapshot, &chrono::Utc::now().to_rfc3339());
    }
    emit_agent_registry_changed(app, snapshot, "interrupted");
}

pub(crate) fn notify_agent_exit(app: &AppHandle, snapshot: &TerminalAgentSnapshot) {
    if let Some(state) = app.try_state::<crate::jarvis::JarvisState>() {
        state.registry.observe_terminal_exit(
            &snapshot.terminal_id,
            snapshot.generation,
            &chrono::Utc::now().to_rfc3339(),
        );
    }
    emit_agent_registry_changed(app, snapshot, "exited");
}

fn emit_agent_registry_changed(app: &AppHandle, snapshot: &TerminalAgentSnapshot, reason: &str) {
    let _ = app.emit(
        "jarvis://agent-registry-changed",
        serde_json::json!({
            "workspaceId": snapshot.workspace_id,
            "terminalId": snapshot.terminal_id,
            "generation": snapshot.generation,
            "reason": reason,
        }),
    );
}
