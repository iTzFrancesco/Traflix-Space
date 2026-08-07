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

pub fn hydrate_process_environment() {
    let _ = read_secret_env(OPENCODE_ZEN_API_KEY_ENV);
    let _ = read_secret_env(GROQ_API_KEY_ENV);
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
    if let Some(value) = env::var(name).ok() {
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
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
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
        JarvisSecretId::OpenCodeZen => OPENCODE_ZEN_API_KEY_ENV,
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_secret;

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
}
