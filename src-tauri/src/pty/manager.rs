use base64::Engine;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use super::windows::ConPty;

pub struct PtyManager {
    ptys: Arc<Mutex<HashMap<String, PtySession>>>,
}

struct PtySession {
    id: String,
    shell: String,
    cols: u16,
    rows: u16,
    pid: u32,
    pty: Arc<ConPty>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(
        &self,
        id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        app: AppHandle,
    ) -> Result<(), String> {
        info!(%id, %shell, cols, rows, ?cwd, "Creazione PTY");
        let conpty = ConPty::new(cols, rows, shell, cwd)?;
        let pid = conpty.pid();
        info!(%id, pid, "PTY creata con successo");

        let pty = Arc::new(conpty);

        let session = PtySession {
            id: id.clone(),
            shell: shell.to_string(),
            cols,
            rows,
            pid,
            pty: pty.clone(),
        };

        self.ptys.lock().unwrap().insert(id.clone(), session);

        let ptys = self.ptys.clone();
        let id_clone = id.clone();

        std::thread::Builder::new()
            .name(format!("pty-read-{}", &id_clone))
            .spawn(move || {
                info!(%id_clone, "Read thread started");
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut buf = vec![0u8; 65536];
                    loop {
                        let result = pty.read_blocking(&mut buf);
                        match result {
                            Ok(0) => {
                                info!(%id_clone, "ReadFile returned 0 bytes (EOF)");
                                break;
                            }
                            Ok(n) => {
                                info!(%id_clone, bytes = n, "Letto chunk da PTY");
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
                            Err(e) => {
                                warn!(%id_clone, error = %e, "ReadFile error");
                                break;
                            }
                        }
                    }
                }));

                if let Err(e) = &result {
                    warn!(%id_clone, panic = ?e, "Read thread panicked");
                }

                info!(%id_clone, "Read thread emitting EOF");
                let _ = app.emit(
                    "pty-output",
                    json!({
                        "id": id_clone,
                        "data": "",
                        "eof": true
                    }),
                );

                let mut ptys_lock = ptys.lock().unwrap();
                if let Some(session) = ptys_lock.get(&id_clone) {
                    if Arc::ptr_eq(&session.pty, &pty) {
                        ptys_lock.remove(&id_clone);
                        info!(%id_clone, "Read thread exiting, session removed");
                    } else {
                        info!(%id_clone, "Read thread exiting, session already replaced");
                    }
                } else {
                    info!(%id_clone, "Read thread exiting, session already removed");
                }
            })
            .ok();

        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        info!(%id, bytes = data.len(), "Write to PTY");
        let ptys = self.ptys.lock().unwrap();
        let session = ptys
            .get(id)
            .ok_or_else(|| {
                warn!(%id, "Write fallita: PTY non trovata");
                "PTY not found".to_string()
            })?;
        session.pty.write(data)?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let ptys = self.ptys.lock().unwrap();
        let session = ptys
            .get(id)
            .ok_or_else(|| {
                warn!(%id, "Resize fallito: PTY non trovata");
                "PTY not found".to_string()
            })?;
        session.pty.resize(cols, rows)?;
        info!(%id, cols, rows, "PTY ridimensionata");
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let session = {
            let mut ptys = self.ptys.lock().unwrap();
            ptys.remove(id)
        };

        if let Some(session) = session {
            let _ = session.pty.kill();
            drop(session);
            info!(%id, "PTY terminata");
        }
        Ok(())
    }

    pub fn get_info(&self, id: &str) -> Result<serde_json::Value, String> {
        let ptys = self.ptys.lock().unwrap();
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

    pub fn cleanup_all(&self) {
        let mut ptys = self.ptys.lock().unwrap();
        let count = ptys.len();
        for (_, session) in ptys.iter() {
            let _ = session.pty.kill();
        }
        ptys.clear();
        info!(count, "Cleanup PTY completato");
    }
}
