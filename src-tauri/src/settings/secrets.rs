use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

pub const GROQ_API_KEY_ENV: &str = "GROQ_API_KEY";
/// C10: legacy — Zen is no longer a Jarvis provider; kept only so child
/// processes keep scrubbing a stale `OPENCODE_ZEN_API_KEY` from the env.
pub const OPENCODE_ZEN_API_KEY_ENV: &str = "OPENCODE_ZEN_API_KEY";
const MAX_SECRET_BYTES: usize = 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JarvisSecretId {
    Groq,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisSecretStatus {
    pub groq_configured: bool,
    pub persistent: bool,
}

pub fn status() -> JarvisSecretStatus {
    JarvisSecretStatus {
        groq_configured: read_secret_env(GROQ_API_KEY_ENV).is_some(),
        persistent: cfg!(windows),
    }
}

pub fn hydrate_process_environment(app: &AppHandle) {
    // Existing process/user environment variables always win over `.env`.
    let _ = read_secret_env(GROQ_API_KEY_ENV);
    load_dotenv_environment(dotenv_candidates(app), false);
}

/// Re-check the supported `.env` locations before a voice request. This keeps
/// development runs plug-and-play when the file was created after the app
/// process started, without ever exposing the values to the frontend.
pub fn refresh_dotenv_environment(app: &AppHandle) {
    // In development, the repository `.env` is the source the owner edits and
    // must win over a stale Windows user variable left by an older setup. In a
    // packaged build we keep the persisted user secret as the fallback.
    #[cfg(debug_assertions)]
    load_dotenv_environment(dotenv_candidates(app), true);
    #[cfg(not(debug_assertions))]
    load_dotenv_environment(dotenv_candidates(app), false);

    let _ = read_secret_env(GROQ_API_KEY_ENV);
}

fn load_dotenv_environment(candidates: Vec<PathBuf>, overwrite_existing: bool) {
    let mut loaded = HashSet::new();
    for path in candidates {
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in contents.lines() {
            let Some((name, value)) = parse_dotenv_assignment(line) else {
                continue;
            };
            if !matches!(name, GROQ_API_KEY_ENV) {
                continue;
            }
            if loaded.contains(name) {
                continue;
            }
            let already_configured = env::var(name)
                .ok()
                .is_some_and(|current| !current.trim().is_empty());
            if already_configured && !overwrite_existing {
                continue;
            }
            if let Ok(value) = normalize_secret(&value) {
                env::set_var(name, value);
                loaded.insert(name.to_string());
            }
        }
    }
}

fn dotenv_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // Development uses the repository root. In a packaged app, also inspect
    // the executable/resource ancestry so launching from a shortcut does not
    // change whether the user-managed `.env` is found.
    if cfg!(debug_assertions) {
        push_ancestor_candidates(
            &mut candidates,
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
        );
    }
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        candidates.push(app_data_dir.join(".env"));
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            push_ancestor_candidates(&mut candidates, parent);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_ancestor_candidates(&mut candidates, &resource_dir);
    }
    if let Ok(current_dir) = env::current_dir() {
        push_ancestor_candidates(&mut candidates, &current_dir);
    }
    candidates.dedup();
    candidates
}

fn push_ancestor_candidates(candidates: &mut Vec<PathBuf>, start: &std::path::Path) {
    for directory in start.ancestors().take(5) {
        candidates.push(directory.join(".env"));
    }
}

fn parse_dotenv_assignment(line: &str) -> Option<(&str, String)> {
    let line = line.trim().trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let line = line.strip_prefix("export ").unwrap_or(line);
    let (name, raw_value) = line.split_once('=')?;
    let name = name.trim();
    if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') {
        return None;
    }
    let value = raw_value.trim();
    let value = if value.starts_with('"') || value.starts_with('\'') {
        value
    } else {
        value
            .split_once(" #")
            .map(|(value, _)| value.trim())
            .unwrap_or(value)
    };
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim()
        .to_string();
    Some((name, value))
}

pub fn set_secret(secret: JarvisSecretId, value: String) -> Result<JarvisSecretStatus, String> {
    let value = normalize_secret(&value)?;
    let name = secret_env_name(secret);
    persist_user_secret(name, Some(&value))?;
    env::set_var(name, value);
    Ok(status())
}

pub fn clear_secret(secret: JarvisSecretId) -> Result<JarvisSecretStatus, String> {
    let name = secret_env_name(secret);
    persist_user_secret(name, None)?;
    env::remove_var(name);
    Ok(status())
}

pub fn read_secret_env(name: &str) -> Option<String> {
    if let Ok(value) = env::var(name) {
        if let Ok(value) = normalize_secret(&value) {
            if env::var(name).ok().as_deref() != Some(value.as_str()) {
                env::set_var(name, &value);
            }
            return Some(value);
        }
    }

    #[cfg(windows)]
    {
        let script = format!(
            "$v=[System.Environment]::GetEnvironmentVariable('{}',[System.EnvironmentVariableTarget]::User); if ($null -ne $v) {{ [Console]::Out.Write($v) }}",
            name
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8(output.stdout).ok()?;
        let value = normalize_secret(&raw).ok()?;
        env::set_var(name, &value);
        return Some(value);
    }

    #[cfg(not(windows))]
    None
}

fn secret_env_name(secret: JarvisSecretId) -> &'static str {
    match secret {
        JarvisSecretId::Groq => GROQ_API_KEY_ENV,
    }
}

fn normalize_secret(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_SECRET_BYTES
        || value.contains('\0')
        || value.contains('\r')
        || value.contains('\n')
    {
        return Err("API key non valida".to_string());
    }
    Ok(value.to_string())
}

#[cfg(windows)]
fn persist_user_secret(name: &str, value: Option<&str>) -> Result<(), String> {
    let script = if value.is_some() {
        format!(
            "$v=[Console]::In.ReadToEnd(); [System.Environment]::SetEnvironmentVariable('{}',$v,[System.EnvironmentVariableTarget]::User)",
            name
        )
    } else {
        format!(
            "[System.Environment]::SetEnvironmentVariable('{}',$null,[System.EnvironmentVariableTarget]::User)",
            name
        )
    };

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(if value.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|_| "non sono riuscito ad aggiornare la credenziale Windows".to_string())?;

    if let Some(value) = value {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "non sono riuscito ad aggiornare la credenziale Windows".to_string())?;
        stdin
            .write_all(value.as_bytes())
            .map_err(|_| "non sono riuscito ad aggiornare la credenziale Windows".to_string())?;
    }

    let status = child
        .wait()
        .map_err(|_| "non sono riuscito ad aggiornare la credenziale Windows".to_string())?;
    if !status.success() {
        return Err("non sono riuscito ad aggiornare la credenziale Windows".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn persist_user_secret(_name: &str, _value: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_secret, parse_dotenv_assignment};

    #[test]
    fn secret_normalization_trims_copy_paste_whitespace() {
        assert_eq!(normalize_secret("  token-value  ").unwrap(), "token-value");
    }

    #[test]
    fn secret_normalization_rejects_empty_multiline_and_oversized_values() {
        assert!(normalize_secret("   ").is_err());
        assert!(normalize_secret("token\nvalue").is_err());
        assert!(normalize_secret(&"x".repeat(1025)).is_err());
    }

    #[test]
    fn dotenv_parser_accepts_comments_exports_and_quotes() {
        assert_eq!(
            parse_dotenv_assignment("export GROQ_API_KEY=\"demo-key\"").map(|(_, value)| value),
            Some("demo-key".to_string())
        );
        assert_eq!(
            parse_dotenv_assignment("GROQ_API_KEY='groq-demo'").map(|(_, value)| value),
            Some("groq-demo".to_string())
        );
        assert_eq!(
            parse_dotenv_assignment("GROQ_API_KEY=groq-demo # local development")
                .map(|(_, value)| value),
            Some("groq-demo".to_string())
        );
        assert_eq!(
            parse_dotenv_assignment("GROQ_API_KEY=\"groq # demo\"").map(|(_, value)| value),
            Some("groq # demo".to_string())
        );
        assert!(parse_dotenv_assignment("# GROQ_API_KEY=ignored").is_none());
        assert!(parse_dotenv_assignment("not valid").is_none());
    }
}
