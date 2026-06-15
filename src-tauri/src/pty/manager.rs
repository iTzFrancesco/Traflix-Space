use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct PtyManager {
    ptys: Arc<Mutex<HashMap<String, PtySession>>>,
}

pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn cleanup_all(&self) {
        let mut ptys = self.ptys.lock().await;
        ptys.clear();
    }
}
