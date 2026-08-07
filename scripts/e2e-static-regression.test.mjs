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
const workspaceCommands = source("../src-tauri/src/workspace/commands.rs");
const jarvisStore = source("../src/stores/jarvisStore.ts");
const jarvisOverlay = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const rustSettings = source("../src-tauri/src/settings/store.rs");
const skillsWatcher = source("../src-tauri/src/skills/watcher.rs");
const windowsTauriConfig = source("../src-tauri/tauri.windows.conf.json");
const windowsPrebuild = source("./tauri-before-build.ps1");
const releaseWorkflow = source("../.github/workflows/release.yml");

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

test("chat completion reserves TTS state before IPC so hands-free cannot rearm into Jarvis speech", () => {
  assert.match(jarvisStore, /const ttsRequestId = `tts-\$\{response\.message\.id\}`/);
  assert.match(jarvisStore, /setTtsStatus\(\{ requestId: ttsRequestId, status: "synthesizing" \}\)/);
  assert.match(jarvisStore, /ttsSpeak\(\{ requestId: ttsRequestId/);
  assert.match(jarvisStore, /status: "failed"/);
  assert.match(jarvisStore, /code: "tts_failed"/);
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
