use tracing::warn;

#[tauri::command]
pub fn kill_process_tree(pid: u32) {
    let result = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match result {
        Ok(_) => {}
        Err(e) => {
            warn!(pid = pid, error = %e, "taskkill fallito");
        }
    }
}
