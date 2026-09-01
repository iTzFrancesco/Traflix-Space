import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const terminalStore = source("../src/stores/terminalStore.ts");
const workspaceStore = source("../src/stores/workspaceStore.ts");
const agents = source("../src/lib/agents.ts");
const agentRegistry = source("../src-tauri/src/agent/registry.rs");
const agentLauncher = source("../src/lib/agentLauncher.ts");
const runtimeDetector = source("../src-tauri/src/jarvis/runtime_detector.rs");
const agentEvents = source("../src-tauri/src/agent_events.rs");
const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
const workspaceWizard = source("../src/components/workspace/NewSpaceWizard.tsx");
const projectWorkspaceSync = source("../src/components/project/ProjectWorkspaceSync.tsx");
const workspaceView = source("../src/components/workspace/WorkspaceView.tsx");
const app = source("../src/App.tsx");
const workspaceCommands = source("../src-tauri/src/workspace/commands.rs");
const workspaceRegistry = source("../src-tauri/src/workspace/registry.rs");
const projectCommands = source("../src-tauri/src/project/commands.rs");
const projectPreview = source("../src/components/project/ProjectFilePreview.tsx");
const projectTypes = source("../src/project/types.ts");
const terminalManager = source("../src-tauri/src/terminal_engine/mod.rs");
const terminalProcess = source("../src-tauri/src/terminal_engine/session_process.rs");
const sidebar = source("../src/components/layout/Sidebar.tsx");
const jarvisStore = source("../src/stores/jarvisStore.ts");
const jarvisStoreModules = [
  jarvisStore,
  source("../src/stores/jarvis/chatSlice.ts"),
  source("../src/stores/jarvis/codexSlice.ts"),
  source("../src/stores/jarvis/runtime.ts"),
].join("\n");
const jarvisOverlay = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const jarvisControl = source("../src-tauri/src/jarvis/control.rs");
const jarvisControlModules = [
  jarvisControl,
  source("../src-tauri/src/jarvis/control/dispatch.rs"),
  source("../src-tauri/src/jarvis/control/execution.rs"),
  source("../src-tauri/src/jarvis/control/lifecycle.rs"),
  source("../src-tauri/src/jarvis/control/reactivation.rs"),
  source("../src-tauri/src/jarvis/control/routing.rs"),
  source("../src-tauri/src/jarvis/control/support.rs"),
].join("\n");
const jarvisThreads = source("../src-tauri/src/jarvis/codex/threads.rs");
const jarvisAccount = source("../src-tauri/src/jarvis/codex/account.rs");
const jarvisTools = source("../src-tauri/src/jarvis/codex/tools.rs");
const jarvisEvents = source("../src-tauri/src/jarvis/codex/events.rs");
const jarvisRuntime = source("../src-tauri/src/jarvis/codex/runtime.rs");
const jarvisChat = source("../src-tauri/src/jarvis/chat.rs");
const jarvisActivity = source("../src/lib/jarvis/activityState.ts");
const rustSettings = source("../src-tauri/src/settings/store.rs");
const secretLoader = source("../src-tauri/src/settings/secrets.rs");
const skillsWatcher = source("../src-tauri/src/skills/watcher.rs");
const windowsTauriConfig = source("../src-tauri/tauri.windows.conf.json");
const windowsPrebuild = source("./tauri-before-build.ps1");
const voiceCapture = source("../src-tauri/src/jarvis/voice/capture.rs");
const voiceAudio = source("../src-tauri/src/jarvis/voice/audio.rs");
const voiceCommandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");
const voiceTts = source("../src-tauri/src/jarvis/voice/tts.rs");
const voiceTtsWorker = source("../src-tauri/src/jarvis/voice/tts_worker.rs");
const voiceTtsModules = [voiceTts, voiceTtsWorker].join("\n");
const voiceStt = source("../src-tauri/src/jarvis/voice/stt.rs");
const viteConfig = source("../vite.config.ts");
const releaseWorkflow = source("../.github/workflows/release.yml");
const ciWorkflow = source("../.github/workflows/ci.yml");
const rustBuildScript = source("../src-tauri/build.rs");
const strictTestRunner = source("./run-strict-tests.mjs");

test("exited PTY generations remain recoverable until the user chooses an action", () => {
  assert.match(terminalStore, /markExited:[\s\S]*agentLaunched: false/);
  assert.match(workspaceGrid, /onClose=\{hasExited \? undefined : onCloseTerminal\}/);
  assert.match(workspaceGrid, /Rimuovi il terminale chiuso/);
  assert.match(workspaceGrid, />\s*Rimuovi\s*<\/button>/);
});

test("PTY sessions remain color-capable when Traflix inherits a no-color launcher", () => {
  assert.match(terminalProcess, /cmd\.env_remove\("NO_COLOR"\)/);
  assert.match(terminalProcess, /cmd\.env\("TERM", "xterm-256color"\)/);
});

test("manual PTY reopen relaunches its configured agent without duplicating Jarvis-owned restarts", () => {
  assert.match(agentLauncher, /useTerminalStore\.subscribe\(\(state, previous\) =>/);
  assert.match(agentLauncher, /before\.exitCode === null/);
  assert.match(agentLauncher, /terminal\.exitCode !== null/);
  assert.match(agentLauncher, /window\.setTimeout\(\(\) =>/);
  assert.match(agentLauncher, /live\.agentLaunched/);
  assert.match(
    agentLauncher,
    /liveStore\.markAgentLaunched\(terminalId, live\.generation\)/,
  );
  assert.match(
    agentLauncher,
    /agentLaunchQueue\.enqueue\(terminalId, live\.generation, agentId\)/,
  );
  assert.match(agentLauncher, /agentLaunchKey\(\{[\s\S]*terminalId,[\s\S]*workspaceId:[\s\S]*generation,[\s\S]*processId:/);
  assert.match(agentLauncher, /terminal\.agentLaunchOwner === "backend"/);
  assert.match(agentLauncher, /terminal\.generation !== generation/);
  assert.match(
    agentLauncher,
    /workspaceId,\s*generation,\s*processId,\s*operationId: `agent-launch:\$\{key\}`,\s*data:/,
  );
});

test("manual agent catalog and Jarvis provider registry stay aligned", () => {
  const manualAgents = [
    "anti-gravity",
    "claude",
    "claudex",
    "codex",
    "opencode",
    "pi",
    "cmdc",
    "cline",
    "freebuff",
    "grok",
  ];
  for (const provider of manualAgents) {
    assert.match(agents, new RegExp(`id: "${provider}"`));
  }

  const jarvisProviders = [
    "anti-gravity",
    "claude",
    "claudex",
    "codex",
    "opencode",
    "pi",
    "cmdc",
    "cline",
    "freebuff",
    "grok",
  ];
  for (const provider of jarvisProviders) {
    assert.match(agentRegistry, new RegExp(`id: "${provider}"\\.into\\(\\)`));
    assert.match(runtimeDetector, new RegExp(`"${provider}"`));
  }

  assert.match(runtimeDetector, /"agy" \| "anti gravity"[\s\S]*"anti-gravity"/);
  assert.match(runtimeDetector, /"command code" => "cmdc"/);
  assert.match(agentEvents, /completion_provider_matches_snapshot/);
  assert.match(agentEvents, /Agent completion ignored: provider mismatch/);
  assert.match(agents, /id: "cmdc"[\s\S]*command: "cmdc"/);
  assert.match(agents, /id: "cline"[\s\S]*command: "cline"/);
  assert.match(agents, /id: "anti-gravity"[\s\S]*command: "agy"/);
});

test("new workspaces validate real directories and the human folder picker has no arbitrary timeout", () => {
  assert.match(workspaceCommands, /fn validate_new_workspace/);
  assert.match(workspaceCommands, /canonical_directory\(&config\.root_path/);
  assert.match(workspaceCommands, /config\.terminals\.is_empty\(\) \|\| config\.terminals\.len\(\) > 8/);
  assert.match(workspaceCommands, /terminal\.workspace_id = Some\(config\.id\.clone\(\)\)/);
  assert.match(workspaceCommands, /preferred_default_workspace_path/);
  assert.match(workspaceCommands, /let file = rx\s*\.await/s);
  assert.doesNotMatch(workspaceCommands, /timeout\(Duration::from_secs\(10\), rx\)/);
  assert.match(workspaceWizard, /invoke<string>\("select_folder"\)/);
  assert.match(workspaceWizard, /folder-selection-cancelled/);
  assert.doesNotMatch(
    workspaceWizard,
    /invokeWithTimeout\([\s\S]{0,160}select_folder/,
  );
  assert.doesNotMatch(workspaceWizard, /30000/);
});

test("workspace deletion shuts down PTYs before persistence and never relies on fire-and-forget cleanup", () => {
  const shutdown = workspaceCommands.indexOf("shutdown_workspace(&app, &id)");
  const remove = workspaceCommands.indexOf("remove_workspace_and_save(&id)", shutdown);
  assert.ok(shutdown >= 0 && remove > shutdown);
  assert.match(terminalManager, /workspace_lifecycle: tokio::sync::Mutex/);
  assert.match(terminalManager, /closing_workspaces: DashSet/);
  assert.match(terminalManager, /workspace-closing/);
  assert.match(terminalStore, /forgetWorkspaceTerminals/);
  assert.doesNotMatch(terminalStore, /fire-and-forget|invoke\("terminal_kill"/);
  assert.match(sidebar, /catch \(error\)[\s\S]*addToast\([\s\S]*return;[\s\S]*forgetWorkspaceTerminals/);
  assert.doesNotMatch(
    workspaceStore,
    /if \(backendWorkspaces\.length === 0\) return/,
    "an empty authoritative registry must not leave ghost local workspaces",
  );
});

test("workspace registry saves through a flushed same-directory atomic replacement", () => {
  assert.match(workspaceRegistry, /NamedTempFile::new_in\(parent\)/);
  assert.match(workspaceRegistry, /write_all\(data\)/);
  assert.match(workspaceRegistry, /sync_all\(\)/);
  assert.match(workspaceRegistry, /\.persist\(path\)/);
  assert.doesNotMatch(workspaceRegistry, /std::fs::write\(&self\.registry_path/);
  assert.match(workspaceRegistry, /mutation_lock: Mutex/);
  assert.match(
    workspaceRegistry,
    /let previous = map\.clone\(\);[\s\S]*if let Err\(error\) = self\.save_map\(&map\)[\s\S]*\*map = previous/,
  );
  assert.match(workspaceRegistry, /append_terminal_and_save/);
  assert.match(workspaceRegistry, /remove_terminal_and_save/);
});

test("dotenv credentials are refreshed without exposing secret values to the frontend", () => {
  assert.match(secretLoader, /pub fn hydrate_process_environment/);
  assert.match(secretLoader, /pub fn refresh_dotenv_environment/);
  assert.match(secretLoader, /load_dotenv_environment\(dotenv_candidates\(app\), cfg!\(debug_assertions\)\)/);
  assert.match(secretLoader, /load_dotenv_environment\(dotenv_candidates\(app\), false\)/);
  assert.match(secretLoader, /push_ancestor_candidates/);
  assert.match(secretLoader, /if !matches!\(name, GROQ_API_KEY_ENV\)/);
  assert.match(secretLoader, /fn parse_dotenv_assignment/);
  assert.match(secretLoader, /GROQ_API_KEY=\\\"groq # demo\\\"/);
  assert.match(secretLoader, /fn dotenv_should_load/);
  assert.match(secretLoader, /if !dotenv_should_load\(env::var\(name\)\.ok\(\)\.as_deref\(\), overwrite_existing\)/);
  assert.doesNotMatch(secretLoader, /println!/i);
  assert.match(voiceCommandsSource, /refresh_dotenv_environment/);
  assert.match(voiceCommandsSource, /from_environment\(\)/);
  const sttSource = source("../src-tauri/src/jarvis/voice/stt.rs");
  assert.match(sttSource, /read_secret_env\(\s*crate::settings::secrets::GROQ_API_KEY_ENV/);
  assert.doesNotMatch(sttSource, /std::env::var\(\s*[\"']GROQ_API_KEY/);
  const voiceRegistry = source("../src-tauri/src/jarvis/voice/registry.rs");
  assert.match(secretLoader, /pub fn is_groq_api_key/);
  assert.match(secretLoader, /GROQ_API_KEY=/);
  assert.match(secretLoader, /Bearer /);
  assert.match(sttSource, /is_groq_api_key/);
  assert.match(voiceRegistry, /credenziale vocale è stata rifiutata/);
  const settingsCommands = source("../src-tauri/src/settings/commands.rs");
  assert.match(settingsCommands, /pub fn jarvis_secret_status\(app: AppHandle\)/);
  assert.match(settingsCommands, /secrets::refresh_dotenv_environment\(&app\)/);
});

test("workspace .env files show raw values in preview", () => {
  assert.doesNotMatch(projectCommands, /L’anteprima dei file di ambiente è disabilitata/);
  assert.doesNotMatch(projectCommands, /fn redact_environment_preview\(/);
  assert.doesNotMatch(projectCommands, /redacted/);
  assert.doesNotMatch(projectTypes, /redacted/);
  assert.doesNotMatch(projectPreview, /Anteprima protetta/);
  assert.match(projectCommands, /fn is_environment_file\(/);
});

test("workspace restore waits for one authoritative backend snapshot", () => {
  assert.match(workspaceStore, /backendReady: boolean/);
  assert.match(workspaceStore, /backendReady: false/);
  assert.match(workspaceStore, /backendReady: true/);
  assert.match(app, /syncWithBackend\(\)/);
  assert.match(workspaceView, /backendReady/);
  assert.match(projectWorkspaceSync, /backendReady/);
  assert.match(
    projectWorkspaceSync,
    /if \(!backendReady \|\| !activeWorkspaceId\) return/,
  );
});

test("manual click-toggle is authoritative and legacy voice modes migrate safely", () => {
  assert.match(rustSettings, /impl Default for VoiceActivationMode[\s\S]*Self::ClickToggle/);
  assert.match(rustSettings, /settings\.voice_input\.activation_mode = VoiceActivationMode::ClickToggle/);
  assert.match(rustSettings, /settings\.voice_input\.auto_submit_transcript = false/);
  assert.match(rustSettings, /settings\.voice_input\.vad_enabled = false/);
  assert.match(rustSettings, /settings\.voice_input\.endpointing_enabled = false/);
  assert.match(rustSettings, /settings\.voice_output\.stop_on_user_speech = false/);
  assert.match(rustSettings, /fn default_max_armed_seconds\(\) -> u32 \{\s*120\s*\}/);
  assert.match(rustSettings, /owner_mode_migrates_click_toggle_but_preserves_hold_to_talk/);
});

test("voice runtime avoids callback data loss, survives Windows Python aliases, and bounds STT language input", () => {
  assert.match(voiceCapture, /sync_channel::<Vec<f32>>\(32\)/);
  assert.match(voiceCapture, /sender\.try_send\(incoming\)/);
  assert.match(voiceCapture, /process_samples\(&buffer, samples\)/);
  assert.match(voiceTtsModules, /launcher\.args\(\["-3", "-u"\]\)/);
  assert.match(voiceTtsModules, /child\.try_wait\(\)/);
  assert.match(voiceStt, /language\.chars\(\)\.any\(\|ch\| ch\.is_control\(\)\)/);
  assert.match(voiceCapture, /perceptual_level/);
  assert.match(voiceCapture, /smooth_perceptual_level/);
  assert.match(voiceAudio, /LEVEL_FLOOR_DB: f32 = -58\.0/);
  assert.match(voiceAudio, /LEVEL_CEILING_DB: f32 = -12\.0/);
  assert.match(voiceAudio, /peak \* 0\.08/);
  assert.match(voiceStt, /bearer_auth/);
  assert.match(voiceTtsModules, /child\.try_wait\(\)/);
});

test("chat completion reserves TTS state before IPC so hands-free cannot rearm into Jarvis speech", () => {
  assert.match(jarvisStoreModules, /const ttsRequestId = `tts-\$\{response\.message\.id\}`/);
  assert.match(jarvisStoreModules, /beginLocalTtsRequest\(state, ttsRequestId, workspaceId\)/);
  assert.match(jarvisStoreModules, /ttsSpeak\(\{[\s\S]*?requestId: ttsRequestId,\s*workspaceId/);
  assert.match(jarvisStoreModules, /status: "failed"/);
  assert.match(jarvisStoreModules, /sanitizedVoiceErrorView\(error, "tts_ipc_failed"\)/);
  assert.match(jarvisStoreModules, /cancelChat\(invocation\.requestId\)/);
});

test("PTY dispatches close their activity checkpoint without inventing turn_started", () => {
  assert.match(
    jarvisControlModules,
    /Scritto; avvio turno non confermato\.[\s\S]{0,180}JarvisActivityStatus::Done/,
  );
  assert.match(jarvisControlModules, /status: DISPATCH_SUBMISSION_UNCONFIRMED/);
  assert.match(jarvisControlModules, /DISPATCH_SUBMISSION_UNCONFIRMED, DISPATCH_TURN_STARTED/);
  assert.match(jarvisActivity, /if \(event\.status === "running"\) return true/);
});

test("inactive and stale agent sessions are rebound to a fresh PTY generation before prompt write", () => {
  assert.match(jarvisControlModules, /reactivate_bound_agent/);
  assert.match(jarvisControlModules, /reactivate_explicit_agent/);
  assert.match(jarvisControlModules, /ensure_target_runtime_for_prompt/);
  assert.match(jarvisControlModules, /refresh_agent_process_presence/);
  assert.match(jarvisControlModules, /target_was_reactivated/);
  assert.match(
    jarvisControlModules,
    /!\s*target_was_reactivated\s*\)\s*\.then_some\(\s*follow_up_binding\s*\)/,
  );
  assert.match(jarvisControlModules, /wait_until_ready/);
  assert.match(jarvisControlModules, /agent_process_alive: Option<bool>/);
});

test("Codex turn cleanup is bounded and late terminal events cannot clear a newer turn", () => {
  assert.match(jarvisThreads, /pub async fn clear_active_turn/);
  assert.match(jarvisThreads, /self\.clear_active_turn\(workspace_id, Some\(&turn_id\)\)/);
  assert.match(jarvisThreads, /notification_turn_id/);
  assert.match(jarvisThreads, /pub async fn terminal_turn_matches/);
  assert.match(jarvisThreads, /terminal_turn_matches_record/);
  assert.doesNotMatch(jarvisThreads, /legacy clear behavior/);
  assert.match(jarvisAccount, /terminal_turn_matches/);
  assert.match(jarvisAccount, /emit_chat_stream[\s\S]*capture_turn_final_fallback[\s\S]*fail_chat_waiter/);
  assert.match(jarvisThreads, /pub async fn set_last_message_text_if_absent/);
  assert.match(jarvisAccount, /set_last_message_text_if_absent/);
  assert.match(jarvisChat, /chat timeout: best-effort turn\/interrupt failed/);
  assert.match(jarvisChat, /interrupt_turn_for_request/);
  assert.match(jarvisChat, /"request",[\s\S]*JarvisActivityStatus::Failed/);
});

test("Codex cancellation and stream fallbacks stay request- and generation-scoped", () => {
  assert.match(jarvisThreads, /struct ChatWaiter/);
  assert.match(jarvisThreads, /fail_chat_waiter_for_request/);
  assert.match(jarvisThreads, /active_turn_matches/);
  assert.match(jarvisAccount, /active_turn_matches\(thread_id, &turn_id\)/);
  assert.match(jarvisAccount, /clear_plan_cancel\(thread_id, &turn_id\)/);
  assert.match(jarvisTools, /HashMap<\(String, String\), CancellationToken>/);
  assert.match(jarvisTools, /missing turnId for conversational\.plan/);
  assert.match(jarvisRuntime, /client\.clone\(\),\s*models/);
  assert.match(jarvisAccount, /for_server_client\(Arc::clone\(&client\)\)/);
  assert.match(jarvisEvents, /final_turn_message_event/);
  assert.match(jarvisStoreModules, /codexChatStreamAvailable/);
  assert.match(jarvisStoreModules, /!progressiveCodexSpeech/);
});

test("failed voice transcript submissions stay preserved without automatic retry loops", () => {
  assert.match(jarvisOverlay, /loadVoiceDraft/);
  assert.doesNotMatch(jarvisOverlay, /settingsRecoveryDraftRef|settingsWasOpenRef|resumeVoiceDraftRef/);
  assert.doesNotMatch(jarvisOverlay, /sendVoiceTranscript\(draft/);
  assert.match(jarvisOverlay, /onVoiceToggle/);
});

test("fresh installations watch the canonical skills directory before the first skill exists", () => {
  assert.match(skillsWatcher, /std::fs::create_dir_all\(&dir\)/);
  assert.match(skillsWatcher, /watcher\.watch\(&dir, RecursiveMode::Recursive\)/);
});

test("strict regression runner gates frontend, formatting, clippy safety and warning-free Rust tests", () => {
  assert.match(strictTestRunner, /npmCommand/);
  assert.match(strictTestRunner, /test:jarvis/);
  assert.match(strictTestRunner, /test:terminal/);
  assert.match(strictTestRunner, /cargoCommand, \["fmt"/);
  assert.match(strictTestRunner, /--check/);
  assert.match(strictTestRunner, /\["check", "--manifest-path", "src-tauri\/Cargo.toml", "--release"\]/);
  assert.match(strictTestRunner, /"-D",\s*"warnings"/);
  assert.match(strictTestRunner, /clippy::result_large_err/);
  assert.match(strictTestRunner, /clippy::too_many_arguments/);
  assert.match(strictTestRunner, /const rustFlags = \[process\.env\.RUSTFLAGS, "-D warnings"\]/);
  assert.match(strictTestRunner, /RUSTFLAGS: rustFlags/);
  assert.match(strictTestRunner, /RUSTFLAGS/);
  assert.match(strictTestRunner, /explicit Clippy baseline/);
});

test("Vite ignores provider checkouts and agent metadata with broken Windows reparse links", () => {
  for (const segment of [
    "agenti-riferimento",
    ".agents",
    ".claude",
    ".codex",
    ".cline",
    ".fallow",
    ".opencode",
    ".pi",
    ".playwright-mcp",
   ".wayfinder",
   ".warp",
 ]) {
    const escapedSegment = segment.replace(".", "\\.");
    assert.match(viteConfig, new RegExp(`\\*\\*/${escapedSegment}\\/\\*\\*`));
  }
  for (const segment of [
    "cline",
    "codebuff",
    "codex",
    "open-code",
    "opencode",
    "p",
    "pi",
    "warp",
  ]) {
    const escapedSegment = segment.replace(".", "\\.");
    assert.match(viteConfig, new RegExp(`agenti-riferimento\\/${escapedSegment}\\/\\*\\*`));
    assert.doesNotMatch(viteConfig, new RegExp(`\\*\\/${escapedSegment}\\/\\*\\*`));
  }
});

test("CI and release builds use runner-local Rust paths and version all MSI inputs", () => {
  assert.doesNotMatch(ciWorkflow, /D:\/rust\/target/);
  assert.doesNotMatch(releaseWorkflow, /D:\/rust\/target/);
  assert.match(ciWorkflow, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/\.cargo-target/);
  assert.match(releaseWorkflow, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/\.cargo-target/);
  assert.match(releaseWorkflow, /Cargo\.lock/);
  assert.match(releaseWorkflow, /fail_on_unmatched_files: true/);
});

test("Windows Rust test binaries activate common-controls v6", () => {
  assert.match(rustBuildScript, /TRAFLIX_RUST_TEST_MANIFEST/);
  assert.match(rustBuildScript, /MANIFESTINPUT/);
  assert.match(rustBuildScript, /Microsoft\.Windows\.Common-Controls/);
  assert.match(rustBuildScript, /6\.0\.0\.0/);
});

test("every Windows MSI build regenerates the current persistent Edge TTS sidecar", () => {
  assert.match(windowsTauriConfig, /tauri-before-build\.ps1/);
  assert.match(windowsTauriConfig, /jarvis-edge-tts/);
  assert.match(windowsPrebuild, /build-jarvis-edge-tts-sidecar\.ps1/);
  assert.match(windowsPrebuild, /Get-Command python/);
  assert.match(windowsPrebuild, /Get-Command py/);
  assert.ok(
    windowsPrebuild.indexOf('Get-Command py') < windowsPrebuild.indexOf('Get-Command python'),
    "the real py launcher must win over the Microsoft Store python alias",
  );
  assert.match(windowsPrebuild, /ReadAllBytes\(\$sidecar\)/);
  assert.match(windowsPrebuild, /\$machine -ne 0x8664/);
  assert.match(windowsPrebuild, /npm run build/);
  assert.match(releaseWorkflow, /actions\/setup-python@v5/);
  assert.match(releaseWorkflow, /npm run tauri build/);
  assert.match(releaseWorkflow, /tauri\.windows\.conf\.json/);
  assert.doesNotMatch(releaseWorkflow, /cache:\s*pip/);
});
