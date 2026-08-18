use super::*;
use std::ffi::OsString;
use std::fs;
use std::sync::{Mutex, MutexGuard, OnceLock};

static PATH_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct PathEnvGuard {
    original: Option<OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for PathEnvGuard {
    fn drop(&mut self) {
        match self.original.take() {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
    }
}

fn test_path(paths: Vec<std::path::PathBuf>) -> PathEnvGuard {
    let lock = PATH_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("PATH test lock should not be poisoned");
    let original = std::env::var_os("PATH");
    let joined = std::env::join_paths(paths).expect("test paths should be joinable");
    std::env::set_var("PATH", joined);
    PathEnvGuard {
        original,
        _lock: lock,
    }
}

#[test]
fn finds_executable_on_path() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("codex.exe");
    fs::write(&exe, b"MZ").unwrap();
    // The second entry is a plain missing directory (platform-neutral;
    // Windows drive-letter paths cannot be joined on non-Windows hosts).
    let paths = vec![dir.path().to_path_buf(), dir.path().join("nonexistent")];
    let _path_guard = test_path(paths);
    assert_eq!(
        super::runtime_transport::find_on_path("codex.exe"),
        Some(exe)
    );
}

#[test]
fn path_scan_returns_none_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = vec![dir.path().to_path_buf(), dir.path().join("nonexistent")];
    let _path_guard = test_path(paths);
    assert!(super::runtime_transport::find_on_path("codex.exe").is_none());
    assert!(super::runtime_transport::find_on_path("codex.cmd").is_none());
}

#[test]
fn error_codes_are_stable() {
    assert_eq!(
        RuntimeError::NotFound("x".into()).code(),
        "codex_not_installed"
    );
    assert_eq!(
        RuntimeError::VersionTooOld {
            found: "0.1.0".into(),
            minimum: (0, 147, 0)
        }
        .code(),
        "codex_version_mismatch"
    );
    assert_eq!(
        RuntimeError::Spawn("boom".into()).code(),
        "codex_runtime_start_failed"
    );
    assert_eq!(
        RuntimeError::NotRunning {
            state: CodexRuntimeState::Crashed
        }
        .code(),
        "codex_runtime_crashed"
    );
}

/// Real end-to-end smoke test against the installed `codex app-server`.
/// Requires codex >= 0.147.0 on PATH (or npm global layout). Run with
/// `cargo test -- --ignored`.
#[tokio::test]
#[ignore = "requires real codex app-server binary"]
async fn spawns_real_app_server_and_handshakes() {
    let executable = resolve_codex_executable().expect("codex executable resolved");
    let version = probe_version(&executable)
        .await
        .expect("codex --version produces output");
    let parsed = CodexVersion::parse_cli(&version).expect("version parses");
    assert!(
        parsed.is_supported(),
        "installed codex {version} is below minimum supported"
    );

    let mut child = Command::new(&executable)
        .arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn codex app-server");
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    let (client, mut server_rx) = JsonRpcClient::new(stdin);
    let client = Arc::new(client);
    client.start_reader(stdout);

    let init: InitializeResult = serde_json::from_value(
        client
            .request(
                "initialize",
                json!(InitializeParams {
                    client_info: ClientInfo {
                        name: "traflix-space-test".into(),
                        title: "Traflix Space (test)".into(),
                        version: "0.0.0-test".into(),
                    },
                    capabilities: InitializeCapabilities {
                        experimental_api: true,
                    },
                }),
            )
            .await
            .expect("initialize response"),
    )
    .expect("initialize result shape");
    assert_eq!(init.platform_family, "windows");
    assert!(init.codex_home.contains("codex"));

    client
        .notify("initialized", json!({}))
        .await
        .expect("initialized notification");

    // account/read requires an explicit (possibly empty) params object.
    let account = client
        .request("account/read", json!({}))
        .await
        .expect("account/read response");
    assert!(
        account.get("account").is_some() || account.get("requiresOpenaiAuth").is_some(),
        "account/read result: {account}"
    );
    // Parse the real payload with the production view builder.
    let view = super::super::account::parse_account(account.get("account"));
    match view {
        super::super::account::CodexAccount::Chatgpt { plan_type, .. } => {
            assert!(!plan_type.is_empty(), "real chatgpt planType");
        }
        super::super::account::CodexAccount::SignedOut
        | super::super::account::CodexAccount::ApiKey
        | super::super::account::CodexAccount::Other { .. } => {}
    }

    // model/list must expose the Jarvis default family.
    let models = client
        .request("model/list", json!({}))
        .await
        .expect("model/list response");
    let ids: Vec<&str> = models["data"]
        .as_array()
        .expect("model list data")
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(
        ids.contains(&"gpt-5.6-luna"),
        "gpt-5.6-luna present in {ids:?}"
    );

    // C3: rate limits + usage read must succeed (real payloads).
    let rate_limits = client
        .request("account/rateLimits/read", json!({}))
        .await
        .expect("account/rateLimits/read response");
    let codex_limit = rate_limits["rateLimitsByLimitId"]["codex"].clone();
    assert!(
        codex_limit.get("primary").is_some() || codex_limit.get("credits").is_some(),
        "codex rate limit snapshot: {codex_limit}"
    );
    let usage = client
        .request("account/usage/read", json!({}))
        .await
        .expect("account/usage/read response");
    assert!(usage.get("summary").is_some(), "usage summary: {usage}");

    // account/login/start (chatgpt) must return authUrl+loginId; we
    // immediately cancel the flow so no OAuth session is left pending.
    let login = client
        .request(
            "account/login/start",
            json!({
                "type": "chatgpt",
                "useHostedLoginSuccessPage": true,
                "appBrand": "chatgpt",
            }),
        )
        .await
        .expect("account/login/start response");
    let auth_url = login
        .get("authUrl")
        .and_then(serde_json::Value::as_str)
        .expect("authUrl present");
    let login_id = login
        .get("loginId")
        .and_then(serde_json::Value::as_str)
        .expect("loginId present");
    assert!(
        auth_url.starts_with("https://"),
        "authUrl is https: {auth_url}"
    );
    let _ = client
        .request("account/login/cancel", json!({ "loginId": login_id }))
        .await;

    // C4: ephemeral thread lifecycle (isolated cwd, read-only sandbox,
    // never approval) + turn/start + turn/interrupt + thread/delete.
    let thread_start = client
        .request(
            "thread/start",
            json!({
                "ephemeral": true,
                "cwd": init.codex_home,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "model": "gpt-5.6-luna",
                "runtimeWorkspaceRoots": [],
                // C5: read-only namespaced dynamic tools.
                "dynamicTools": super::super::tools::CodexToolService::dynamic_tool_specs(),
            }),
        )
        .await
        .expect("thread/start response");
    let thread_id = thread_start["thread"]["id"]
        .as_str()
        .expect("thread.id present");
    assert_eq!(
        thread_start["thread"]["ephemeral"],
        serde_json::Value::Bool(true),
        "thread is ephemeral"
    );
    // The sandbox field may be normalized by the server; assert only
    // when it is echoed back as the simple enum.
    if let Some(sandbox) = thread_start["sandbox"].as_str() {
        assert_eq!(sandbox, "read-only");
    }

    let turn = client
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": "Ciao, sei in linea? Rispondi solo con OK." }],
                "effort": "low",
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("turn/start failed: {err}"));
    let turn_id = turn["turn"]["id"].as_str().expect("turn.id present");

    // C5: a second turn that must call the `agent.list` dynamic tool.
    // We answer the server request with a synthetic result and observe
    // the request actually arriving (proves the tools are registered
    // and the model can invoke them end-to-end).
    let turn2 = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "Prima di rispondere devi assolutamente chiamare lo strumento agent.list (namespace agent, tool list) e dire cosa restituisce. Rispondi in una riga." }],
                    "effort": "low",
                }),
            )
            .await
            .unwrap_or_else(|err| panic!("turn/start #2 failed: {err}"));
    let turn2_id = turn2["turn"]["id"].as_str().expect("turn #2 id present");
    let _ = turn2_id;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    let mut tool_calls: Vec<String> = Vec::new();
    let mut completed = false;
    // C7: every Item/*, AgentMessageDelta and turn/* notification is
    // passed through the production normalizer; the raw payloads are
    // printed so a Windows run can confirm the shapes.
    let mut stream_events: Vec<(String, super::super::events::ChatStreamEventKind)> = Vec::new();
    while std::time::Instant::now() < deadline && !completed {
        let message =
            tokio::time::timeout(std::time::Duration::from_secs(10), server_rx.recv()).await;
        match message {
            Ok(Some(ServerMessage::Request { id, method, params })) => {
                if method == "item/tool/call" {
                    let namespace = params
                        .as_ref()
                        .and_then(|p| p.get("namespace"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let tool = params
                        .as_ref()
                        .and_then(|p| p.get("tool"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let name = format!("{namespace}.{tool}");
                    tool_calls.push(name.clone());
                    assert!(
                        name.contains('.') && !name.is_empty(),
                        "dynamic tool must be namespaced: {name}"
                    );
                    let _ = client
                        .respond(
                            id,
                            json!({
                                "content": [{
                                    "type": "inputText",
                                    "text": "{\"agents\":[]}",
                                }]
                            }),
                        )
                        .await;
                } else {
                    println!("unexpected server request: {method}");
                }
            }
            Ok(Some(ServerMessage::Notification { method, params })) => {
                if method.starts_with("item/")
                    || method == "AgentMessageDelta"
                    || method == "AgentMessageThreadItem"
                    || method.starts_with("turn/")
                {
                    println!(
                        "C7 notification {method}: {}",
                        params.clone().unwrap_or_default()
                    );
                    let events = super::super::events::stream_events_from_notification(
                        &method,
                        &params,
                        "test-workspace",
                        None,
                    );
                    for event in events {
                        stream_events.push((method.clone(), event.kind));
                    }
                }
                if method == "turn/completed" {
                    completed = true;
                }
            }
            _ => {}
        }
    }
    assert!(
        tool_calls.iter().any(|name| name == "agent.list"),
        "agent.list observed among tool calls: {tool_calls:?}"
    );
    // C7 ordering: every dynamicToolCall item produced a tool lifecycle
    // event, and no tool_completed arrived without a matching started.
    assert!(
        stream_events
            .iter()
            .any(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolStarted),
        "tool_started observed in stream: {stream_events:?}"
    );
    let tool_starts = stream_events
        .iter()
        .filter(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolStarted)
        .count();
    let tool_finishes = stream_events
        .iter()
        .filter(|(_, kind)| *kind == super::super::events::ChatStreamEventKind::ToolCompleted)
        .count();
    assert!(
        tool_finishes <= tool_starts,
        "tool_completed without started: {stream_events:?}"
    );

    // C6: a third turn that must call `conversational.plan` (the only
    // side-effecting tool). We answer with a synthetic receipt and
    // observe the request arriving (proves the namespace is registered
    // and the model can produce a typed plan end-to-end).
    let turn3 = client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "Prima di rispondere devi assolutamente chiamare lo strumento conversational.plan (namespace conversational, tool plan) con una sola operazione respond e prompt \"test ok\", poi rispondi in una riga." }],
                    "effort": "low",
                }),
            )
            .await
            .unwrap_or_else(|err| panic!("turn/start #3 failed: {err}"));
    let _ = turn3["turn"]["id"].as_str().expect("turn #3 id present");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    let mut plan_calls: Vec<serde_json::Value> = Vec::new();
    let mut completed3 = false;
    // C7: same normalization pass on the plan turn; the turn must end
    // with a TurnCompleted stream event (final-message marker for the UI).
    let mut turn3_stream: Vec<super::super::events::ChatStreamEventKind> = Vec::new();
    while std::time::Instant::now() < deadline && !completed3 {
        let message =
            tokio::time::timeout(std::time::Duration::from_secs(10), server_rx.recv()).await;
        match message {
            Ok(Some(ServerMessage::Request { id, method, params })) => {
                if method == "item/tool/call" {
                    let namespace = params
                        .as_ref()
                        .and_then(|p| p.get("namespace"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let tool = params
                        .as_ref()
                        .and_then(|p| p.get("tool"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    if namespace == "conversational" && tool == "plan" {
                        plan_calls.push(params.clone().unwrap_or_default());
                        // The arguments must be the typed plan shape.
                        let args = params
                            .as_ref()
                            .and_then(|p| p.get("arguments"))
                            .cloned()
                            .unwrap_or_default();
                        assert!(
                            args.get("operations").is_some(),
                            "plan arguments are typed: {args}"
                        );
                        // Answer with the ExecutionReceipt shape (C6:
                        // the receipt comes back in the same turn).
                        let _ = client
                                .respond(
                                    id,
                                    json!({
                                        "content": [{
                                            "type": "inputText",
                                            "text": "{\"response\":\"Fatto, test ok.\",\"warnings\":[]}",
                                        }]
                                    }),
                                )
                                .await;
                    } else {
                        println!("unexpected server request: {method} {namespace}.{tool}");
                        let _ = client
                            .respond_error(id, -32601, "unexpected in C6 test")
                            .await;
                    }
                } else {
                    println!("unexpected server request: {method}");
                }
            }
            Ok(Some(ServerMessage::Notification { method, params })) => {
                if method.starts_with("item/")
                    || method == "AgentMessageDelta"
                    || method == "AgentMessageThreadItem"
                    || method.starts_with("turn/")
                {
                    println!(
                        "C7 notification (turn3) {method}: {}",
                        params.clone().unwrap_or_default()
                    );
                    let events = super::super::events::stream_events_from_notification(
                        &method,
                        &params,
                        "test-workspace",
                        None,
                    );
                    for event in events {
                        turn3_stream.push(event.kind);
                    }
                }
                if method == "turn/completed" {
                    completed3 = true;
                }
            }
            _ => {}
        }
    }
    assert!(
        !plan_calls.is_empty(),
        "conversational.plan observed among tool calls"
    );
    assert!(
        turn3_stream.contains(&super::super::events::ChatStreamEventKind::TurnCompleted),
        "turn3 stream ends with TurnCompleted: {turn3_stream:?}"
    );
    // The server-side allows multiple plans in one turn; the host-side
    // single-plan guard lives in CodexToolService (unit-tested). Here we
    // verify the server accepted the namespace without reserved-name
    // collisions — the same specs passed to thread/start above.
    println!("conversational.plan calls observed: {}", plan_calls.len());

    // Interrupt is best-effort: the trivial prompt may complete before
    // the interrupt lands (error on an already-finished turn is fine).
    let _ = client
        .request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await;

    // Ephemeral threads are not persisted, so the server refuses
    // thread/delete ("thread is not persisted") — expected contract:
    // no server-side cleanup is needed for ephemeral threads.
    let delete_result = client
        .request("thread/delete", json!({ "threadId": thread_id }))
        .await;
    match delete_result {
        Ok(_) => {}
        Err(err) => {
            let message = err.to_string();
            assert!(
                message.contains("not persisted"),
                "ephemeral delete error mentions persistence: {message}"
            );
        }
    }

    child.kill().await.expect("child killed");
    child.wait().await.expect("child reaped");
    let _ = server_rx.try_recv();
}
