pub struct TerminalSession {
    pub id: String,
    pub workspace_id: String,
    pub pty_id: Option<String>,
    pub title: String,
    pub process: String,
}
