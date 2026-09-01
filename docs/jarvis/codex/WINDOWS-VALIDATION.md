# Windows Validation

Traflix Space is a Windows desktop application. Portable checks can validate
Rust logic and protocol handling, but they do not prove ConPTY, native dialogs,
system-tray behavior, WebView2, named pipes, audio devices, sidecar startup, or
MSI packaging.

## Portable checks

From the repository root:

```powershell
npm run test:jarvis
npm run test:terminal
npm run test:strict
```

The Rust test suite can also be run from `src-tauri` with the Windows test
manifest environment enabled by the strict test runner.

## Live Codex App Server check

When the Codex CLI is installed and authenticated, run the ignored handshake
test from `src-tauri`:

```powershell
cargo test -- --ignored spawns_real_app_server_and_handshakes --nocapture
```

The check covers executable resolution, the `initialize` handshake, account and
model reads, ephemeral workspace-thread creation, dynamic-tool requests,
conversational-plan receipts, stream normalization, and turn completion.

## Manual application checks

Verify the following on a Windows machine with the application running:

1. Jarvis starts one workspace-bound turn from typed input and from voice input.
2. Commentary and tool lifecycle events appear in the advanced Jarvis view;
   the final text is identified after turn completion.
3. Optional commentary speech is queued without overlapping the final response,
   and cancellation clears pending speech.
4. Cancel stops the Codex turn and prevents a pending plan from applying after
   the next host checkpoint.
5. Steering is available only for an active turn and rejects an idle thread.
6. The Codex account view exposes status without exposing OAuth token material.
7. Groq is the only optional voice credential exposed by the application.
8. No project file, secret, or terminal child process receives the Codex OAuth
   token through Traflix IPC.
