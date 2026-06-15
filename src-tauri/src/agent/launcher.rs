use tauri::AppHandle;

pub struct AgentLauncher {
    _app: AppHandle,
}

impl AgentLauncher {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }

    pub async fn launch(
        &self,
        _agent_id: &str,
        _cwd: &str,
    ) -> Result<(), String> {
        // TODO: Launch agent process
        Ok(())
    }

    pub async fn kill(
        &self,
        _agent_id: &str,
    ) -> Result<(), String> {
        // TODO: Kill agent process
        Ok(())
    }
}
