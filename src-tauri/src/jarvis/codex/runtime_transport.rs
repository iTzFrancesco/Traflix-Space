//! Process/OS adapter for the Codex App Server runtime.
//!
//! The runtime lifecycle owns state transitions and restart policy. This
//! module owns the platform-specific process seam: locating Codex, probing its
//! version, hiding its console window, and terminating a child process.

use std::path::{Path, PathBuf};

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub(super) fn kill_pid(pid: u32) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;

    std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?
        .wait()?;
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn kill_pid(pid: u32) -> std::io::Result<()> {
    let _ = unsafe { libc_kill(pid as i32, 15) };
    Ok(())
}

#[cfg(not(windows))]
unsafe extern "C" {
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

#[cfg(windows)]
pub(super) fn configure_hidden_process(command: &mut Command) {
    // A packaged Tauri executable has no console of its own. Codex is a
    // console-subsystem binary, so without CREATE_NO_WINDOW Windows creates
    // a visible terminal for every App Server.
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(super) fn configure_hidden_process(_command: &mut Command) {}

/// Resolves the `codex` executable. Order:
/// 1. `codex.exe` on PATH;
/// 2. npm global install layout (the `codex` shim on Windows is a POSIX
///    script, so we resolve the vendored native binary directly);
/// 3. `codex.cmd` / `codex` on PATH as last resort (spawned via shell).
pub(super) fn resolve_codex_executable() -> Result<PathBuf, String> {
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

pub(super) fn find_on_path(name: &str) -> Option<PathBuf> {
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
pub(super) async fn probe_version(executable: &Path) -> Option<String> {
    let mut command = Command::new(executable);
    configure_hidden_process(&mut command);
    let output = command.arg("--version").output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or_default().trim();
    (!first.is_empty()).then(|| first.to_string())
}
