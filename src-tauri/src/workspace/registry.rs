use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tempfile::NamedTempFile;
use tokio::sync::Mutex;
#[cfg(unix)]
use tracing::warn;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub layout: GridLayout,
    pub terminals: Vec<TerminalConfig>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    pub id: String,
    pub shell: String,
    pub agent_id: Option<String>,
    pub command: Option<String>,
    pub cwd: String,
    pub title: String,
    /// Owning workspace. Exposed to the PTY as TRAFLIX_WORKSPACE_ID so the
    /// agent-event bridge can correlate completions with the right workspace.
    /// `default` keeps older persisted workspaces.json files parseable.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

pub struct WorkspaceRegistry {
    workspaces: Arc<Mutex<HashMap<String, WorkspaceConfig>>>,
    loaded: AtomicBool,
    load_lock: Mutex<()>,
    mutation_lock: Mutex<()>,
    registry_path: PathBuf,
    _app: AppHandle,
}

impl WorkspaceRegistry {
    pub fn new(app: AppHandle) -> Self {
        let registry_path = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("traflix-space")
            .join("workspaces.json");

        let workspaces = Arc::new(Mutex::new(HashMap::new()));

        Self {
            workspaces,
            loaded: AtomicBool::new(false),
            load_lock: Mutex::new(()),
            mutation_lock: Mutex::new(()),
            registry_path,
            _app: app,
        }
    }

    pub async fn load(&self) -> Result<(), String> {
        let _load = self.load_lock.lock().await;
        if self.loaded.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.registry_path.exists() {
            self.loaded.store(true, Ordering::Release);
            return Ok(());
        }
        let data = std::fs::read_to_string(&self.registry_path)
            .map_err(|e| format!("Errore lettura registry: {}", e))?;
        let list: Vec<WorkspaceConfig> =
            serde_json::from_str(&data).map_err(|e| format!("Errore parsing registry: {}", e))?;
        let mut next = HashMap::new();
        for mut workspace in list {
            if next.contains_key(&workspace.id) {
                return Err("workspace_id_duplicate".to_string());
            }
            for terminal in &mut workspace.terminals {
                terminal.workspace_id = Some(workspace.id.clone());
            }
            validate_terminal_identity(&next, &workspace)?;
            next.insert(workspace.id.clone(), workspace);
        }
        *self.workspaces.lock().await = next;
        self.loaded.store(true, Ordering::Release);
        Ok(())
    }

    fn save_map(&self, map: &HashMap<String, WorkspaceConfig>) -> Result<(), String> {
        let mut list: Vec<&WorkspaceConfig> = map.values().collect();
        list.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let data = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("Errore serializzazione: {}", e))?;
        atomic_replace(&self.registry_path, data.as_bytes())
    }

    async fn mutate_and_save<T, F>(&self, mutate: F) -> Result<T, String>
    where
        F: FnOnce(&mut HashMap<String, WorkspaceConfig>) -> Result<T, String>,
    {
        let _mutation = self.mutation_lock.lock().await;
        let mut map = self.workspaces.lock().await;
        let previous = map.clone();
        let value = match mutate(&mut map) {
            Ok(value) => value,
            Err(error) => {
                *map = previous;
                return Err(error);
            }
        };
        if let Err(error) = self.save_map(&map) {
            *map = previous;
            return Err(error);
        }
        Ok(value)
    }

    pub async fn insert_and_save(
        &self,
        config: WorkspaceConfig,
    ) -> Result<WorkspaceConfig, String> {
        self.mutate_and_save(move |map| {
            if map.contains_key(&config.id) {
                return Err("ID workspace già esistente".to_string());
            }
            validate_terminal_identity(map, &config)?;
            map.insert(config.id.clone(), config.clone());
            Ok(config)
        })
        .await
    }

    pub async fn replace_and_save_if_updated_at(
        &self,
        workspace_id: &str,
        expected_updated_at: &str,
        mut config: WorkspaceConfig,
    ) -> Result<WorkspaceConfig, String> {
        let workspace_id = workspace_id.to_string();
        let expected_updated_at = expected_updated_at.to_string();
        self.mutate_and_save(move |map| {
            let current = map
                .get(&workspace_id)
                .ok_or_else(|| "Workspace non trovato".to_string())?;
            if current.updated_at != expected_updated_at {
                return Err("workspace_revision_conflict".to_string());
            }
            let previous_updated_at = current.updated_at.clone();
            validate_terminal_identity(map, &config)?;
            config.updated_at = next_updated_at(&previous_updated_at);
            map.insert(workspace_id, config.clone());
            Ok(config)
        })
        .await
    }

    pub async fn remove_workspace_and_save(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceConfig, String> {
        let workspace_id = workspace_id.to_string();
        self.mutate_and_save(move |map| {
            map.remove(&workspace_id)
                .ok_or_else(|| "Workspace non trovato".to_string())
        })
        .await
    }

    pub async fn get_all(&self) -> Vec<WorkspaceConfig> {
        let map = self.workspaces.lock().await;
        let mut workspaces = map.values().cloned().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        workspaces
    }

    pub async fn get(&self, id: &str) -> Option<WorkspaceConfig> {
        let map = self.workspaces.lock().await;
        map.get(id).cloned()
    }

    pub async fn append_terminal_and_save(
        &self,
        workspace_id: &str,
        terminal: TerminalConfig,
        max_terminals: usize,
    ) -> Result<WorkspaceConfig, String> {
        let workspace_id = workspace_id.to_string();
        self.mutate_and_save(move |map| {
            if map.iter().any(|(other_workspace_id, workspace)| {
                other_workspace_id != &workspace_id
                    && workspace
                        .terminals
                        .iter()
                        .any(|item| item.id == terminal.id)
            }) {
                return Err("terminal_id_workspace_collision".to_string());
            }
            let workspace = map
                .get_mut(&workspace_id)
                .ok_or_else(|| "workspace non disponibile".to_string())?;
            if workspace
                .terminals
                .iter()
                .any(|item| item.id == terminal.id)
            {
                return Ok(workspace.clone());
            }
            if workspace.terminals.len() >= max_terminals {
                return Err(format!(
                    "limite di {max_terminals} terminali raggiunto in questa workspace"
                ));
            }
            workspace.terminals.push(terminal);
            workspace.updated_at = next_updated_at(&workspace.updated_at);
            Ok(workspace.clone())
        })
        .await
    }

    pub async fn remove_terminal_and_save(
        &self,
        workspace_id: &str,
        terminal_id: &str,
    ) -> Result<Option<WorkspaceConfig>, String> {
        let workspace_id = workspace_id.to_string();
        let terminal_id = terminal_id.to_string();
        self.mutate_and_save(move |map| {
            let Some(workspace) = map.get_mut(&workspace_id) else {
                return Ok(None);
            };
            workspace
                .terminals
                .retain(|terminal| terminal.id != terminal_id);
            workspace.updated_at = next_updated_at(&workspace.updated_at);
            Ok(Some(workspace.clone()))
        })
        .await
    }

    pub async fn update_terminal_title_and_save(
        &self,
        workspace_id: &str,
        terminal_id: &str,
        title: &str,
    ) -> Result<WorkspaceConfig, String> {
        let workspace_id = workspace_id.to_string();
        let terminal_id = terminal_id.to_string();
        let title = title.to_string();
        self.mutate_and_save(move |map| {
            let workspace = map
                .get_mut(&workspace_id)
                .ok_or_else(|| "Workspace non trovata".to_string())?;
            let terminal = workspace
                .terminals
                .iter_mut()
                .find(|terminal| terminal.id == terminal_id)
                .ok_or_else(|| "Terminale non trovato".to_string())?;
            terminal.title = title;
            workspace.updated_at = next_updated_at(&workspace.updated_at);
            Ok(workspace.clone())
        })
        .await
    }
}

/// Stage the complete registry beside the destination, flush it, then replace
/// the old document in one filesystem operation. `NamedTempFile::persist`
/// uses `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` on Windows, so a process
/// crash cannot leave a partially truncated `workspaces.json` behind.
fn atomic_replace(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Errore creazione directory registry: {error}"))?;

    let mut staged = NamedTempFile::new_in(parent)
        .map_err(|error| format!("Errore creazione file temporaneo registry: {error}"))?;
    staged
        .write_all(data)
        .map_err(|error| format!("Errore scrittura file temporaneo registry: {error}"))?;
    staged
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("Errore flush file temporaneo registry: {error}"))?;
    staged
        .persist(path)
        .map_err(|error| format!("Errore sostituzione atomica registry: {}", error.error))?;

    // Persisting the file makes its contents durable; syncing the containing
    // directory also makes the rename durable on Unix. Windows uses the native
    // atomic replacement implementation supplied by `tempfile`.
    #[cfg(unix)]
    if let Err(error) = std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
        // The atomic rename has already committed and cannot honestly be
        // rolled back by the caller. Keep memory aligned with the visible file
        // and record the reduced power-loss durability instead of returning an
        // error that would restore only the in-memory map.
        warn!(
            error = %error,
            "Registry directory metadata flush failed after atomic replacement"
        );
    }

    Ok(())
}

fn validate_terminal_identity(
    workspaces: &HashMap<String, WorkspaceConfig>,
    candidate: &WorkspaceConfig,
) -> Result<(), String> {
    if candidate.terminals.len() > 8 {
        return Err("workspace_terminal_limit".to_string());
    }
    let mut candidate_ids = HashSet::new();
    for terminal in &candidate.terminals {
        if terminal.id.trim().is_empty() || !candidate_ids.insert(terminal.id.as_str()) {
            return Err("terminal_id_duplicate".to_string());
        }
    }
    if workspaces.iter().any(|(workspace_id, workspace)| {
        workspace_id != &candidate.id
            && workspace
                .terminals
                .iter()
                .any(|terminal| candidate_ids.contains(terminal.id.as_str()))
    }) {
        return Err("terminal_id_workspace_collision".to_string());
    }
    Ok(())
}

/// Produce a strict monotonic ISO timestamp even if two independent mutations
/// land in the same clock tick. `updatedAt` is the registry CAS token, so equal
/// timestamps would otherwise permit a stale full-workspace overwrite.
fn next_updated_at(current: &str) -> String {
    let now = Utc::now();
    let current = DateTime::parse_from_rfc3339(current)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    let next = match current {
        Some(previous) if previous >= now => previous
            .checked_add_signed(TimeDelta::nanoseconds(1))
            .unwrap_or(now),
        _ => now,
    };
    next.to_rfc3339_opts(SecondsFormat::Nanos, true)
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_replace, next_updated_at, validate_terminal_identity, GridLayout, TerminalConfig,
        WorkspaceConfig,
    };
    use std::collections::HashMap;

    fn workspace(id: &str, terminal_ids: &[&str]) -> WorkspaceConfig {
        WorkspaceConfig {
            id: id.to_string(),
            name: id.to_string(),
            root_path: "C:\\repo".to_string(),
            layout: GridLayout { rows: 1, cols: 1 },
            terminals: terminal_ids
                .iter()
                .map(|terminal_id| TerminalConfig {
                    id: (*terminal_id).to_string(),
                    shell: "powershell.exe".to_string(),
                    agent_id: None,
                    command: None,
                    cwd: "C:\\repo".to_string(),
                    title: (*terminal_id).to_string(),
                    workspace_id: Some(id.to_string()),
                })
                .collect(),
            created_at: "2026-08-09T00:00:00Z".to_string(),
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn workspace_revision_is_strictly_monotonic_even_for_a_future_value() {
        let current = "2999-01-01T00:00:00.000000000Z";
        let next = next_updated_at(current);
        assert_ne!(next, current);
        assert!(
            chrono::DateTime::parse_from_rfc3339(&next).unwrap()
                > chrono::DateTime::parse_from_rfc3339(current).unwrap()
        );
    }

    #[test]
    fn terminal_ids_are_unique_within_and_across_workspaces() {
        let existing = workspace("workspace-a", &["left", "right"]);
        let mut workspaces = HashMap::new();
        workspaces.insert(existing.id.clone(), existing);

        assert!(
            validate_terminal_identity(&workspaces, &workspace("workspace-b", &["other"]),).is_ok()
        );
        assert_eq!(
            validate_terminal_identity(&workspaces, &workspace("workspace-b", &["left"]),)
                .unwrap_err(),
            "terminal_id_workspace_collision",
        );
        assert_eq!(
            validate_terminal_identity(&workspaces, &workspace("workspace-b", &["same", "same"]),)
                .unwrap_err(),
            "terminal_id_duplicate",
        );
        assert_eq!(
            validate_terminal_identity(
                &workspaces,
                &workspace(
                    "workspace-b",
                    &["1", "2", "3", "4", "5", "6", "7", "8", "9"],
                ),
            )
            .unwrap_err(),
            "workspace_terminal_limit",
        );
    }

    #[test]
    fn registry_replacement_never_exposes_a_partially_written_document() {
        let directory = tempfile::tempdir().expect("temporary registry directory");
        let path = directory.path().join("workspaces.json");
        std::fs::write(&path, br#"[{"id":"old"}]"#).expect("old registry fixture");

        let replacement = br#"[{"id":"new","terminals":["left","right"]}]"#;
        atomic_replace(&path, replacement).expect("atomic registry replacement");

        let persisted = std::fs::read(&path).expect("persisted registry");
        assert_eq!(persisted, replacement);
        let parsed: serde_json::Value =
            serde_json::from_slice(&persisted).expect("complete JSON document");
        assert_eq!(parsed[0]["id"], "new");
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("registry directory")
                .count(),
            1,
            "the staged file must not remain beside workspaces.json",
        );
    }
}
