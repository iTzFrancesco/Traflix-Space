use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilesChanged {
    pub workspace_id: String,
    pub paths: Vec<String>,
    pub git_metadata_changed: bool,
    pub revision: u64,
}

#[derive(Default)]
pub struct ProjectWatcherRegistry {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    revisions: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

impl ProjectWatcherRegistry {
    pub fn watch(
        &self,
        app: AppHandle,
        workspace_id: String,
        root: PathBuf,
        additional_roots: Vec<PathBuf>,
    ) -> Result<(), String> {
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "Project watcher non disponibile".to_string())?;
        if watchers.contains_key(&workspace_id) {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();
        let callback = move |result| {
            let _ = tx.send(result);
        };
        let mut watcher = RecommendedWatcher::new(callback, Config::default())
            .map_err(|error| format!("Impossibile creare il watcher: {error}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("Impossibile osservare la workspace: {error}"))?;
        for additional_root in additional_roots {
            // The workspace watcher already covers nested repository roots.
            // Watching the child a second time duplicates notify events and
            // amplifies Git refreshes during cargo/Vite output.
            if additional_root == root || additional_root.starts_with(&root) {
                continue;
            }
            watcher
                .watch(&additional_root, RecursiveMode::Recursive)
                .map_err(|error| format!("Impossibile osservare la root Git: {error}"))?;
        }

        let revision = {
            let mut revisions = self
                .revisions
                .lock()
                .map_err(|_| "Project watcher non disponibile".to_string())?;
            revisions
                .entry(workspace_id.clone())
                .or_insert_with(|| Arc::new(AtomicU64::new(0)))
                .clone()
        };
        let event_app = app.clone();
        let event_workspace = workspace_id.clone();
        let event_root = root.clone();
        let event_revision = revision.clone();
        thread::spawn(move || {
            watch_events(event_app, event_workspace, event_root, event_revision, rx)
        });

        watchers.insert(workspace_id, watcher);
        Ok(())
    }

    pub fn unwatch(&self, workspace_id: &str) -> Result<(), String> {
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "Project watcher non disponibile".to_string())?;
        watchers.remove(workspace_id);
        Ok(())
    }
}

fn watch_events(
    app: AppHandle,
    workspace_id: String,
    root: PathBuf,
    revision: Arc<AtomicU64>,
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
) {
    let debounce = Duration::from_millis(500);

    while let Ok(first) = rx.recv() {
        let mut events = vec![first];
        while let Ok(event) = rx.recv_timeout(debounce) {
            events.push(event);
        }

        let mut paths = HashSet::new();
        let mut git_metadata_changed = false;
        for event in events {
            match event {
                Ok(event) => {
                    if !is_relevant_event(&event.kind) {
                        continue;
                    }
                    for path in event.paths {
                        git_metadata_changed |= is_git_metadata_path(&path);
                        if let Some(relative) = relative_path(&root, &path) {
                            paths.insert(relative);
                        }
                    }
                }
                Err(_) => {
                    git_metadata_changed = true;
                }
            }
        }

        let next_revision = revision.fetch_add(1, Ordering::Relaxed) + 1;
        let mut paths: Vec<String> = paths.into_iter().collect();
        paths.sort();
        let _ = app.emit(
            "project-files-changed",
            ProjectFilesChanged {
                workspace_id: workspace_id.clone(),
                paths,
                git_metadata_changed,
                revision: next_revision,
            },
        );
    }
}

fn is_relevant_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Other
    )
}

fn is_git_metadata_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value == ".git" || value == "HEAD" || value == "index" || value == "refs"
    })
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let value = relative.to_string_lossy().replace('\\', "/");
    (!value.is_empty()).then_some(value)
}
