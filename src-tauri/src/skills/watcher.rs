use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use tauri::{AppHandle, Emitter};

/// Costruisce il path `{home}\.agents\skills`
fn skills_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let mut path = PathBuf::from(home);
    path.push(".agents");
    path.push("skills");
    Some(path)
}

/// Avvia il watcher sulla cartella skills in un thread separato.
/// Emette evento `skills-changed` via Tauri quando rileva modifiche.
pub fn start_skills_watcher(app: AppHandle) {
    let dir = match skills_dir() {
        Some(d) => d,
        None => {
            tracing::warn!("Impossibile determinare home directory — skills watcher non avviato");
            return;
        }
    };

    if !dir.exists() {
        tracing::info!("Cartella skills non trovata: {:?} — watcher non avviato", dir);
        return;
    }

    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("Errore creazione skills watcher: {:?}", e);
            return;
        }
    };

    if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
        tracing::error!("Errore avvio watch skills: {:?}", e);
        return;
    }

    // Debounce: raccogli eventi per 500ms prima di emettere
    thread::spawn(move || {
        let mut last_emit = std::time::Instant::now();
        let debounce_ms = std::time::Duration::from_millis(500);

        loop {
            match rx.recv() {
                Ok(Ok(event)) => {
                    // Filtra solo eventi rilevanti (modifiche a file/cartelle)
                    match event.kind {
                        EventKind::Create(_)
                        | EventKind::Modify(_)
                        | EventKind::Remove(_) => {
                            let now = std::time::Instant::now();
                            if now.duration_since(last_emit) >= debounce_ms {
                                last_emit = now;
                                let _ = app.emit("skills-changed", ());
                                tracing::debug!("Skills cambiato — evento emesso");
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Err(e)) => {
                    tracing::error!("Skills watcher error: {:?}", e);
                }
                Err(mpsc::RecvError) => {
                    tracing::info!("Skills watcher terminato (canale chiuso)");
                    break;
                }
            }
        }
    });

    tracing::info!("Skills watcher avviato su: {:?}", dir);
}
