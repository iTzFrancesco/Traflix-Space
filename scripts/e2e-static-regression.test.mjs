import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const terminalStore = source("../src/stores/terminalStore.ts");
const agentLauncher = source("../src/lib/agentLauncher.ts");
const workspaceGrid = source("../src/components/workspace/WorkspaceGrid.tsx");
const rustSettings = source("../src-tauri/src/settings/store.rs");
const skillsWatcher = source("../src-tauri/src/skills/watcher.rs");
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

test("fresh installations watch the canonical skills directory before the first skill exists", () => {
  assert.match(skillsWatcher, /std::fs::create_dir_all\(&dir\)/);
  assert.match(skillsWatcher, /watcher\.watch\(&dir, RecursiveMode::Recursive\)/);
});

test("tagged MSI releases rebuild the current persistent Edge TTS helper", () => {
  assert.match(releaseWorkflow, /actions\/setup-python@v5/);
  assert.match(releaseWorkflow, /build-jarvis-edge-tts-sidecar\.ps1/);
  assert.match(releaseWorkflow, /jarvis-edge-tts-x86_64-pc-windows-msvc\.exe/);
  assert.match(releaseWorkflow, /npm run tauri build/);
  assert.doesNotMatch(releaseWorkflow, /cache:\s*pip/);
});
