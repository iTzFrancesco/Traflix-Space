use serde::{Deserialize, Serialize};
use std::env;
#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::process::{Command, Stdio};

pub const OPENCODE_ZEN_API_KEY_ENV: &str = "OPENCODE_ZEN_API_KEY";
pub const GROQ_API_KEY_ENV: &str = "GROQ_API_KEY";
const MAX_SECRET_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JarvisSecretId {
    OpenCodeZen,
    Groq,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisSecretStatus {
    pub open_code_zen_configured: bool,
    pub groq_configured: bool,
    pub persistent: bool,
}

pub fn status() -> JarvisSecretStatus {
    JarvisSecretStatus {
        open_code_zen_configured: read_secret_env(OPENCODE_ZEN_API_KEY_ENV).is_some(),
        groq_configured: read_secret_env(GROQ_API_KEY_ENV).is_some(),
        persistent: cfg!(windows),
    }
}

pub fn set_secret(secret: JarvisSecretId, value: String) -> Result<JarvisSecretStatus, String> {
    validate_secret(&value)?;
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
    if let Some(value) = env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(value);
    }

    #[cfg(windows)]
    {
        let script = format!(
            "$v=[Environment]::GetEnvironmentVariable('{}',[EnvironmentVariableTarget]::User); if ($null -ne $v) {{ [Console]::Out.Write($v) }}",
            name
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8(output.stdout).ok()?;
        if value.trim().is_empty() {
            return None;
        }
        // Cache the persisted user value in this process so normal provider
        // requests do not need another registry lookup.
        env::set_var(name, &value);
        return Some(value);
    }

    #[cfg(not(windows))]
    None
}

fn secret_env_name(secret: JarvisSecretId) -> &'static str {
    match secret {
        JarvisSecretId::OpenCodeZen => OPENCODE_ZEN_API_KEY_ENV,
        JarvisSecretId::Groq => GROQ_API_KEY_ENV,
    }
}

fn validate_secret(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_SECRET_BYTES
        || value.contains('\0')
        || value.contains('\r')
        || value.contains('\n')
    {
        return Err("API key non valida".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn persist_user_secret(name: &str, value: Option<&str>) -> Result<(), String> {
    let script = if value.is_some() {
        format!(
            "$v=[Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable('{}',$v,[EnvironmentVariableTarget]::User)",
            name
        )
    } else {
        format!(
            "[Environment]::SetEnvironmentVariable('{}',$null,[EnvironmentVariableTarget]::User)",
            name
        )
    };

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(if value.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
    // Linux/VPS keeps the existing environment-variable behavior. The desktop
    // UI persistence path is intentionally Windows-only for now.
    Ok(())
}
