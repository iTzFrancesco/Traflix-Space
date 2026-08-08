import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const terminalStore = source("../src/stores/terminalStore.ts");
const agents = source("../src/lib/agents.ts");
const agentRegistry = source("../src-tauri/src/agent/registry.rs");
const agentLauncher = source("../src/lib/agentLauncher.ts");
const runtimeDetector = source("../src-tauri/src/jarvis/runtime_detector.rs");
const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
const workspaceWizard = source("../src/components/workspace/NewSpaceWizard.tsx");
const workspaceCommands = source("../src-tauri/src/workspace/commands.rs");
const jarvisStore = source("../src/stores/jarvisStore.ts");
const jarvisOverlay = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const rustSettings = source("../src-tauri/src/settings/store.rs");
const secretLoader = source("../src-tauri/src/settings/secrets.rs");
const skillsWatcher = source("../src-tauri/src/skills/watcher.rs");
const windowsTauriConfig = source("../src-tauri/tauri.windows.conf.json");
const windowsPrebuild = source("./tauri-before-build.ps1");
const voiceCapture = source("../src-tauri/src/jarvis/voice/capture.rs");
const voiceCommandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");
const voiceTts = source("../src-tauri/src/jarvis/voice/tts.rs");
const voiceStt = source("../src-tauri/src/jarvis/voice/stt.rs");
const releaseWorkflow = source("../.github/workflows/release.yml");
const strictTestRunner = source("./run-strict-tests.mjs");

test("exited PTY generations remain recoverable until the user chooses an action", () => {
  assert.match(terminalStore, /markExited:[\s\S]*agentLaunched: false/);
  assert.match(workspaceGrid, /onClose=\{hasExited \? undefined : onCloseTerminal\}/);
  assert.match(workspaceGrid, /Rimuovi il terminale chiuso/);
  assert.match(workspaceGrid, />\s*Rimuovi\s*<\/button>/);
});

test("manual PTY reopen relaunches its configured agent without duplicating Jarvis-owned restarts", () => {
  assert.match(agentLauncher, /useTerminalStore\.subscribe\(\(state, previous\) =>/);
  assert.match(agentLauncher, /before\.exitCode === null/);
  assert.match(agentLauncher, /terminal\.exitCode !== null/);
  assert.match(agentLauncher, /window\.setTimeout\(\(\) =>/);
  assert.match(agentLauncher, /live\.agentLaunched/);
  assert.match(agentLauncher, /liveStore\.markAgentLaunched\(terminalId\)/);
  assert.match(agentLauncher, /agentLaunchQueue\.enqueue\(terminalId, agentId\)/);
});

test("manual agent catalog is complete while Jarvis advertises only readiness-verified providers", () => {
  const manualAgents = [
    "anti-gravity",
    "claude",
    "codex",
    "opencode",
    "pi",
    "cmdc",
    "cline",
    "freebuff",
  ];
  for (const provider of manualAgents) {
    assert.match(agents, new RegExp(`id: "${provider}"`));
  }

  const jarvisProviders = ["claude", "codex", "opencode", "pi", "freebuff"];
  for (const provider of jarvisProviders) {
    assert.match(agentRegistry, new RegExp(`id: "${provider}"\\.into\\(\\)`));
    assert.match(runtimeDetector, new RegExp(`"${provider}"`));
  }

  for (const manualOnly of ["anti-gravity", "cmdc", "cline"]) {
    assert.doesNotMatch(agentRegistry, new RegExp(`id: "${manualOnly}"\\.into\\(\\)`));
  }
  assert.match(runtimeDetector, /manual_provider_from_executable/);
  assert.match(runtimeDetector, /"agy" => Some\("anti-gravity"\.to_string\(\)\)/);
  assert.match(runtimeDetector, /"cmdc" => Some\("cmdc"\.to_string\(\)\)/);
  assert.match(runtimeDetector, /"cline" => Some\("cline"\.to_string\(\)\)/);
  assert.match(runtimeDetector, /for manual_only in \["agy", "anti-gravity", "cmdc", "command code", "cline"\]/);
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

test("dotenv credentials are refreshed without exposing secret values to the frontend", () => {
  assert.match(secretLoader, /pub fn hydrate_process_environment/);
  assert.match(secretLoader, /pub fn refresh_dotenv_environment/);
  assert.match(secretLoader, /let _ = read_secret_env\(OPENCODE_ZEN_API_KEY_ENV\);[\s\S]*let _ = read_secret_env\(GROQ_API_KEY_ENV\);[\s\S]*load_dotenv_environment/);
  assert.match(secretLoader, /push_ancestor_candidates/);
  assert.match(secretLoader, /OPENCODE_ZEN_API_KEY_ENV \| GROQ_API_KEY_ENV/);
  assert.match(secretLoader, /fn parse_dotenv_assignment/);
  assert.match(secretLoader, /export OPENCODE_ZEN_API_KEY/);
  assert.match(secretLoader, /GROQ_API_KEY=\\\"groq # demo\\\"/);
  assert.match(secretLoader, /if already_configured && !overwrite_existing \{\s*continue;\s*\}/s);
  assert.doesNotMatch(secretLoader, /println!/i);
  assert.match(voiceCommandsSource, /refresh_dotenv_environment/);
  assert.match(voiceCommandsSource, /from_environment\(\)/);
  const settingsCommands = source("../src-tauri/src/settings/commands.rs");
  assert.match(settingsCommands, /pub fn jarvis_secret_status\(app: AppHandle\)/);
  assert.match(settingsCommands, /secrets::refresh_dotenv_environment\(&app\)/);
});

test("hands-free VAD is authoritative in backend defaults and legacy click-toggle migration", () => {
  assert.match(rustSettings, /impl Default for VoiceActivationMode[\s\S]*Self::Vad/);
  assert.match(
    rustSettings,
    /activation_mode == VoiceActivationMode::ClickToggle[\s\S]*VoiceActivationMode::Vad/,
  );
  assert.match(
    rustSettings,
    /activation_mode: VoiceActivationMode::Vad/,
  );
  assert.match(rustSettings, /fn default_max_armed_seconds\(\) -> u32 \{\s*120\s*\}/);
  assert.match(rustSettings, /owner_mode_migrates_click_toggle_but_preserves_hold_to_talk/);
});

test("voice runtime avoids callback data loss, survives Windows Python aliases, and bounds STT language input", () => {
  assert.match(voiceCapture, /sync_channel::<Vec<f32>>\(32\)/);
  assert.match(voiceCapture, /sender\.try_send\(incoming\)/);
  assert.match(voiceCapture, /process_samples\(&buffer, samples\)/);
  assert.match(voiceTts, /launcher\.args\(\["-3", "-u"\]\)/);
  assert.match(voiceTts, /child\.try_wait\(\)/);
  assert.match(voiceStt, /language\.chars\(\)\.any\(\|ch\| ch\.is_control\(\)\)/);
  assert.match(voiceCapture, /perceptual_level/);
  assert.match(voiceTts, /child\.try_wait\(\)/);
});

test("chat completion reserves TTS state before IPC so hands-free cannot rearm into Jarvis speech", () => {
  assert.match(jarvisStore, /const ttsRequestId = `tts-\$\{response\.message\.id\}`/);
  assert.match(jarvisStore, /setTtsStatus\(\{ requestId: ttsRequestId, status: "synthesizing" \}\)/);
  assert.match(jarvisStore, /ttsSpeak\(\{ requestId: ttsRequestId/);
  assert.match(jarvisStore, /status: "failed"/);
  assert.match(jarvisStore, /code: "tts_failed"/);
  assert.match(jarvisStore, /cancelChat\(invocation\.requestId\)/);
});

test("failed voice transcript submissions stay preserved without automatic retry loops", () => {
  assert.match(jarvisOverlay, /settingsRecoveryDraftRef/);
  assert.match(jarvisOverlay, /settingsWasOpenRef/);
  assert.match(jarvisOverlay, /previousChatFailed/);
  assert.match(jarvisOverlay, /\(!previousChatFailed \|\| recoveryAllowed\)/);
  assert.match(jarvisOverlay, /settingsRecoveryDraftRef\.current\.delete\(draft\.requestId\)/);
  assert.match(jarvisOverlay, /resumeVoiceDraftRef\.current\.has\(draft\.requestId\)/);
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

test("every Windows MSI build regenerates the current persistent Edge TTS sidecar", () => {
  assert.match(windowsTauriConfig, /tauri-before-build\.ps1/);
  assert.match(windowsTauriConfig, /jarvis-edge-tts/);
  assert.match(windowsPrebuild, /build-jarvis-edge-tts-sidecar\.ps1/);
  assert.match(windowsPrebuild, /Get-Command python/);
  assert.match(windowsPrebuild, /Get-Command py/);
  assert.match(windowsPrebuild, /npm run build/);
  assert.match(releaseWorkflow, /actions\/setup-python@v5/);
  assert.match(releaseWorkflow, /npm run tauri build/);
  assert.match(releaseWorkflow, /tauri\.windows\.conf\.json/);
  assert.doesNotMatch(releaseWorkflow, /cache:\s*pip/);
});
