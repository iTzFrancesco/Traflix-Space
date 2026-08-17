use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAdapterStatus {
    pub provider: &'static str,
    pub installed: bool,
    pub path: String,
    pub detail: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAdapterHealth {
    pub ready: bool,
    pub bridge_available: bool,
    pub adapters: Vec<NotificationAdapterStatus>,
    pub restart_required: bool,
    pub message: String,
}

#[tauri::command]
pub fn jarvis_notification_adapter_status(app: AppHandle) -> NotificationAdapterHealth {
    adapter_health(&app, false)
}

#[tauri::command]
pub async fn jarvis_notification_adapter_install(
    app: AppHandle,
) -> Result<NotificationAdapterHealth, String> {
    let directory = resolve_adapter_directory(&app)
        .ok_or_else(|| "Risorse degli adapter di notifica non trovate".to_string())?;
    let installer = directory.join("install-adapters.ps1");
    let bridge = directory.join("traflix-agent-event.ps1");
    let mut command = tokio::process::Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(&installer).arg("-BridgePath").arg(&bridge);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "Installazione adapter scaduta".to_string())?
        .map_err(|error| format!("Avvio installer non riuscito: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Installazione adapter non riuscita: {}",
            bounded_detail(&stderr)
        ));
    }
    Ok(adapter_health(&app, true))
}

fn adapter_health(app: &AppHandle, restart_required: bool) -> NotificationAdapterHealth {
    let bridge_available = resolve_adapter_directory(app)
        .is_some_and(|directory| directory.join("traflix-agent-event.ps1").is_file());
    let profile = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let specs = [
        (
            "codex",
            profile.join(".codex").join("config.toml"),
            "traflix-agent-event.ps1",
            "notify hook",
        ),
        (
            "claude",
            profile.join(".claude").join("settings.json"),
            "traflix-agent-event.ps1",
            "Notification hook",
        ),
        (
            "claudex",
            profile.join(".claude").join("settings.json"),
            "traflix-agent-event.ps1",
            "Notification hook condiviso con Claude",
        ),
        (
            "opencode",
            profile
                .join(".config")
                .join("opencode")
                .join("plugin")
                .join("opencode-traflix-plugin.ts"),
            "TRAFLIX_AGENT_EVENT_BRIDGE",
            "plugin",
        ),
        (
            "pi",
            profile
                .join(".pi")
                .join("agent")
                .join("extensions")
                .join("traflix-notify.ts"),
            "agent_settled",
            "extension",
        ),
        (
            "cline",
            profile
                .join(".cline")
                .join("hooks")
                .join("TaskComplete.ps1"),
            "traflix-agent-event.ps1",
            "TaskComplete hook",
        ),
    ];
    let adapters = specs
        .into_iter()
        .map(
            |(provider, path, marker, detail)| NotificationAdapterStatus {
                provider,
                installed: file_contains(&path, marker),
                path: compact_path(&path, &profile, &local),
                detail,
            },
        )
        .collect::<Vec<_>>();
    let ready = bridge_available && adapters.iter().all(|adapter| adapter.installed);
    NotificationAdapterHealth {
        ready,
        bridge_available,
        adapters,
        restart_required,
        message: if ready {
            if restart_required {
                "Adapter installati. Riavvia gli agenti già aperti.".to_string()
            } else {
                "Notifiche di completamento operative.".to_string()
            }
        } else {
            "Uno o più adapter non sono collegati: senza hook Jarvis mantiene lo stato unknown/working anziché inventare un completamento.".to_string()
        },
    }
}

fn resolve_adapter_directory(app: &AppHandle) -> Option<PathBuf> {
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("agent-notifications"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("agent-notifications");
    [resource, Some(development)]
        .into_iter()
        .flatten()
        .find(|path| path.join("install-adapters.ps1").is_file())
}

fn file_contains(path: &Path, marker: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|content| content.contains(marker))
}

fn compact_path(path: &Path, profile: &Path, local: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(profile) {
        return format!("~\\{}", relative.display());
    }
    if let Ok(relative) = path.strip_prefix(local) {
        return format!("%LOCALAPPDATA%\\{}", relative.display());
    }
    path.display().to_string()
}

fn bounded_detail(value: &str) -> String {
    value.chars().take(500).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::file_contains;

    #[test]
    fn health_check_requires_the_traflix_marker_not_just_a_config_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        std::fs::write(&path, "notify = ['other-tool']").unwrap();
        assert!(!file_contains(&path, "traflix-agent-event.ps1"));
        std::fs::write(&path, "notify = ['traflix-agent-event.ps1']").unwrap();
        assert!(file_contains(&path, "traflix-agent-event.ps1"));
    }
}
