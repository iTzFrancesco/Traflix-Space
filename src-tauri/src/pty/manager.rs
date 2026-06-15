use base64::Engine;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use super::windows::ConPty;

pub struct PtyManager {
    ptys: Arc<Mutex<HashMap<String, PtySession>>>,
}

pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: u32,
    pub pty: ConPty,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create(
        &self,
        id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        app: AppHandle,
    ) -> Result<(), String> {
        info!(%id, %shell, cols, rows, "Creazione PTY");
        let pty = ConPty::new(cols, rows, shell, cwd)?;
        let pid = pty.pid();
        info!(%id, pid, "PTY creata con successo");

        let session = PtySession {
            id: id.clone(),
            shell: shell.to_string(),
            cols,
            rows,
            pid,
            pty,
        };

        self.ptys.lock().await.insert(id.clone(), session);

        let ptys_clone = self.ptys.clone();
        let id_clone = id.clone();

        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                let result = {
                    let mut ptys = ptys_clone.lock().await;
                    let session = match ptys.get_mut(&id_clone) {
                        Some(s) => s,
                        None => break,
                    };
                    session.pty.read_blocking(&mut buf)
                };

                match result {
                    Ok(0) => {
                        let _ = app.emit(
                            "pty-output",
                            json!({
                                "id": id_clone,
                                "data": "",
                                "eof": true
                            }),
                        );
                        break;
                    }
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit(
                            "pty-output",
                            json!({
                                "id": id_clone,
                                "data": data,
                                "eof": false
                            }),
                        );
                    }
                    Err(_) => break,
                }
            }

            let mut ptys = ptys_clone.lock().await;
            ptys.remove(&id_clone);
        });

        Ok(())
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut ptys = self.ptys.lock().await;
        let session = ptys
            .get_mut(id)
            .ok_or_else(|| {
                warn!(%id, "Write fallita: PTY non trovata");
                "PTY not found".to_string()
            })?;
        session.pty.write(data)?;
        Ok(())
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut ptys = self.ptys.lock().await;
        let session = ptys
            .get_mut(id)
            .ok_or_else(|| {
                warn!(%id, "Resize fallito: PTY non trovata");
                "PTY not found".to_string()
            })?;
        session.pty.resize(cols, rows)?;
        session.cols = cols;
        session.rows = rows;
        info!(%id, cols, rows, "PTY ridimensionata");
        Ok(())
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let mut ptys = self.ptys.lock().await;
        if let Some(mut session) = ptys.remove(id) {
            session.pty.kill()?;
            info!(%id, "PTY terminata");
        }
        Ok(())
    }

    pub async fn get_info(&self, id: &str) -> Result<serde_json::Value, String> {
        let ptys = self.ptys.lock().await;
        let session = ptys.get(id).ok_or_else(|| {
            warn!(%id, "GetInfo fallito: PTY non trovata");
            "PTY not found".to_string()
        })?;
        Ok(json!({
            "id": session.id,
            "shell": session.shell,
            "cols": session.cols,
            "rows": session.rows,
            "pid": session.pid,
        }))
    }

    pub async fn cleanup_all(&self) {
        let mut ptys = self.ptys.lock().await;
        let count = ptys.len();
        for (_, session) in ptys.iter_mut() {
            let _ = session.pty.kill();
        }
        ptys.clear();
        info!(count, "Cleanup PTY completato");
    }

    pub async fn list(&self) -> Vec<String> {
        let ptys = self.ptys.lock().await;
        ptys.keys().cloned().collect()
    }
}
