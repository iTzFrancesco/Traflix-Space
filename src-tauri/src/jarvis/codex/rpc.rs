use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use tracing::{debug, warn};

use super::types::JSONRPC_VERSION;

/// Default per-request timeout. App Server can legitimately take a while to
/// answer turn/tool requests; control-plane requests (account/read, model/list)
/// are fast, so a single generous bound is fine for C1 and tightened later.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A message arriving from the server that is *not* a response to one of our
/// requests: either a notification (no `id`) or a server-initiated request
/// (has `id`, expects a response from us — e.g. `item/tool/call`).
/// Fields are consumed by the event bridge in C2/C5+.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum ServerMessage {
    Notification { method: String, params: Option<Value> },
    Request { id: u64, method: String, params: Option<Value> },
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum RpcError {
    #[error("codex app server response timeout for {method}")]
    Timeout { method: String },
    #[error("codex app server returned error {code}: {message}")]
    Server { code: i64, message: String },
    #[error("codex app server closed the stream: {0}")]
    StreamClosed(String),
    #[error("invalid JSON-RPC envelope: {0}")]
    Protocol(String),
    #[error("codex app server transport error: {0}")]
    Transport(String),
}

/// JSON-RPC 2.0 client over a `codex app-server` stdio pipe.
///
/// - One reader task owns stdout and dispatches responses to pending
///   requests; server notifications/requests go to `server_events`.
/// - Lines are newline-delimited JSONL; partial lines are buffered, malformed
///   lines are counted and skipped (fail-soft on framing, fail-closed on
///   protocol version — handled by the runtime).
pub struct JsonRpcClient {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>,
    server_events: mpsc::UnboundedSender<ServerMessage>,
    next_id: AtomicU64,
    malformed_lines: AtomicU64,
}

impl JsonRpcClient {
    pub fn new(stdin: ChildStdin) -> (Self, mpsc::UnboundedReceiver<ServerMessage>) {
        let (server_events, rx) = mpsc::unbounded_channel();
        let client = Self {
            stdin: Mutex::new(stdin),
            pending: Arc::new(Mutex::new(HashMap::new())),
            server_events,
            next_id: AtomicU64::new(1),
            malformed_lines: AtomicU64::new(0),
        };
        (client, rx)
    }

    /// Spawns the reader task that consumes stdout until EOF.
    pub fn start_reader(self: &Arc<Self>, stdout: ChildStdout) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => {
                        // EOF: notify all pending requests the stream is gone.
                        let pending = std::mem::take(&mut *this.pending.lock().await);
                        for (_, tx) in pending {
                            let _ = tx.send(Err(RpcError::StreamClosed(
                                "codex app server stdout closed".into(),
                            )));
                        }
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        this.handle_line(trimmed).await;
                    }
                    Err(err) => {
                        warn!(error = %err, "codex app-server stdout read error");
                        let pending = std::mem::take(&mut *this.pending.lock().await);
                        for (_, tx) in pending {
                            let _ = tx.send(Err(RpcError::Transport(err.to_string())));
                        }
                        break;
                    }
                }
            }
        });
    }

    async fn handle_line(&self, line: &str) {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(err) => {
                let count = self.malformed_lines.fetch_add(1, Ordering::Relaxed) + 1;
                warn!(count, error = %err, line_preview = %&line[..line.len().min(120)], "malformed JSON-RPC line from codex app-server");
                return;
            }
        };

        let is_request = message.get("method").is_some() && message.get("id").is_some();
        let is_notification = message.get("method").is_some() && message.get("id").is_none();

        if is_request || is_notification {
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let params = message.get("params").cloned();
            if is_request {
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let _ = self.server_events.send(ServerMessage::Request {
                        id,
                        method,
                        params,
                    });
                }
            } else {
                let _ = self
                    .server_events
                    .send(ServerMessage::Notification { method, params });
            }
            return;
        }

        // Response to one of our requests.
        let id = match message.get("id").and_then(Value::as_u64) {
            Some(id) => id,
            None => {
                warn!("response without id from codex app-server");
                return;
            }
        };
        let tx = self.pending.lock().await.remove(&id);
        let Some(tx) = tx else {
            debug!(id, "response for unknown request id");
            return;
        };
        if let Some(error) = message.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-1);
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let _ = tx.send(Err(RpcError::Server { code, message: text }));
        } else if let Some(result) = message.get("result") {
            let _ = tx.send(Ok(result.clone()));
        } else {
            let _ = tx.send(Err(RpcError::Protocol(
                "response with neither result nor error".into(),
            )));
        }
    }

    /// Sends a request and awaits its response (or error/timeout).
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&payload)
            .map_err(|err| RpcError::Protocol(err.to_string()))?;
        line.push('\n');

        let result = async {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|err| RpcError::Transport(err.to_string()))?;
            stdin.flush().await.map_err(|err| RpcError::Transport(err.to_string()))?;
            drop(stdin);
            rx.await.map_err(|_| RpcError::StreamClosed(method.to_string()))?
        };

        match timeout(REQUEST_TIMEOUT, result).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(err)) => Err(err),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::Timeout {
                    method: method.to_string(),
                })
            }
        }
    }

    /// Fire-and-forget notification (e.g. `initialized`).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        let payload = json!({
            "jsonrpc": JSONRPC_VERSION,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&payload)
            .map_err(|err| RpcError::Protocol(err.to_string()))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|err| RpcError::Transport(err.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|err| RpcError::Transport(err.to_string()))
    }

    /// Count of malformed JSON lines observed (diagnostics; C7 surfaces it).
    #[allow(dead_code)]
    pub fn malformed_line_count(&self) -> u64 {
        self.malformed_lines.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A dummy long-running child (Windows `timeout` builtin) provides real
    // stdio pipes without invoking codex. The JsonRpcClient logic is then
    // exercised by feeding lines straight into handle_line.
    fn dummy_child() -> tokio::process::Child {
        tokio::process::Command::new("cmd.exe")
            .args(["/c", "timeout", "/t", "30"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn dummy child")
    }

    fn client_with_pipes() -> (Arc<JsonRpcClient>, mpsc::UnboundedReceiver<ServerMessage>) {
        let mut child = dummy_child();
        let stdin = child.stdin.take().unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let client = Arc::new(JsonRpcClient {
            stdin: Mutex::new(stdin),
            pending: Arc::new(Mutex::new(HashMap::new())),
            server_events: tx,
            next_id: AtomicU64::new(1),
            malformed_lines: AtomicU64::new(0),
        });
        (client, rx)
    }

    // Direct unit tests: JsonRpcClient::handle_line routes correctly.
    #[tokio::test]
    async fn routes_responses_notifications_and_server_requests() {
        let (client, mut rx) = client_with_pipes();

        // Response for a request we never sent: ignored (no panic).
        client
            .handle_line(r#"{"jsonrpc":"2.0","id":99,"result":{"ok":true}}"#)
            .await;

        // Notification.
        client
            .handle_line(r#"{"jsonrpc":"2.0","method":"account/updated","params":{"x":1}}"#)
            .await;
        match rx.recv().await.unwrap() {
            ServerMessage::Notification { method, params } => {
                assert_eq!(method, "account/updated");
                assert_eq!(params, Some(json!({"x": 1})));
            }
            _ => panic!("expected notification"),
        }

        // Server-initiated request (dynamic tool call shape).
        client
            .handle_line(r#"{"jsonrpc":"2.0","id":7,"method":"item/tool/call","params":{"tool":"x"}}"#)
            .await;
        match rx.recv().await.unwrap() {
            ServerMessage::Request { id, method, .. } => {
                assert_eq!(id, 7);
                assert_eq!(method, "item/tool/call");
            }
            _ => panic!("expected server request"),
        }

        // Malformed line: counted, not panicking.
        client.handle_line("this is not json {").await;
        assert_eq!(client.malformed_line_count(), 1);
    }

    #[tokio::test]
    async fn resolves_pending_request_from_response() {
        let (client, mut rx) = client_with_pipes();

        let (pending_tx, pending_rx) = oneshot::channel();
        client.pending.lock().await.insert(5, pending_tx);

        client
            .handle_line(r#"{"jsonrpc":"2.0","id":5,"result":{"model":"gpt-5.6-luna"}}"#)
            .await;
        let resolved = pending_rx.await.unwrap().unwrap();
        assert_eq!(resolved["model"], "gpt-5.6-luna");
        assert!(client.pending.lock().await.is_empty());
        // No server message should have been emitted for a response.
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn routes_error_response_to_pending_request() {
        let (client, _rx) = client_with_pipes();
        let (pending_tx, pending_rx) = oneshot::channel();
        client.pending.lock().await.insert(3, pending_tx);
        client
            .handle_line(r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"method not found"}}"#)
            .await;
        match pending_rx.await.unwrap() {
            Err(RpcError::Server { code, message }) => {
                assert_eq!(code, -32601);
                assert_eq!(message, "method not found");
            }
            _ => panic!("expected server error"),
        }
    }
}
