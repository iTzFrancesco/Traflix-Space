import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const exists = (path) => existsSync(new URL(path, import.meta.url));

const modalSource = source("../src/components/ui/Modal.tsx");
const uiStoreSource = source("../src/stores/uiStore.ts");
const presetStoreSource = source("../src/stores/presetStore.ts");
const widgetSource = source("../src/components/jarvis/JarvisWidget.tsx");
const overlaySource = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const globalsSource = source("../src/styles/globals.css");
const settingsSource = source("../src/components/layout/SettingsModal.tsx");
const sidebarSource = source("../src/components/layout/Sidebar.tsx");
const rightPanelSource = source("../src/components/layout/RightPanel.tsx");
const skillsSource = source("../src/components/skills/SkillsModule.tsx");
const jarvisSettingsSource = source("../src/lib/jarvis/settings.ts");
const rustSettingsSource = source("../src-tauri/src/settings/store.rs");
const voiceTypesSource = source("../src-tauri/src/jarvis/voice/types.rs");
const gitChangesSource = source("../src/components/project/ProjectGitChanges.tsx");
const workspaceViewSource = source("../src/components/workspace/WorkspaceView.tsx");
const agentLauncherSource = source("../src/lib/agentLauncher.ts");

const obsoleteJarvisUi = [
  "../src/components/jarvis/JarvisExpandedPanel.tsx",
  "../src/components/jarvis/JarvisChatPanel.tsx",
  "../src/components/jarvis/JarvisChatInput.tsx",
  "../src/components/jarvis/JarvisTranscriptCard.tsx",
  "../src/components/jarvis/JarvisPendingActionCard.tsx",
  "../src/components/jarvis/JarvisAgentList.tsx",
  "../src/components/jarvis/JarvisActivityStrip.tsx",
];

test("obsolete Jarvis text drawer components stay removed", () => {
  for (const path of obsoleteJarvisUi) assert.equal(exists(path), false, path);
});

test("voice widget contract no longer carries dead drawer state", () => {
  assert.doesNotMatch(
    widgetSource,
    /JarvisConversationMessage|JarvisProviderStatus|JarvisUiIntent|onSendMessage|onSendVoiceTranscript|onConfirmAction|onRejectAction|onUpdateAction|onOpenTerminal/,
  );
  assert.doesNotMatch(
    overlaySource,
    /loadConversation|conversationForWorkspace|terminalList|setActiveTerminal|uiIntents|followUps|confirmPendingAction|rejectPendingAction|updatePendingAction/,
  );
  assert.match(overlaySource, /subscribeAgentTurnCompleted/);
  assert.match(overlaySource, /loadVoiceDraft/);
});

test("ready voice draft resumes only in its origin workspace, while enabled, and retries without duplicate sends", () => {
  assert.match(
    overlaySource,
    /if \(!activeWorkspaceId \|\| !settings\.jarvis\.enabled \|\| settingsOpen\) return/,
  );
  assert.match(
    overlaySource,
    /useWorkspaceStore\.getState\(\)\.activeWorkspaceId !== workspaceId/,
  );
  assert.match(overlaySource, /resumeVoiceDraftRef = useRef<Set<string>>/);
  assert.match(overlaySource, /const chatBusy = Object\.values\(store\.requests\)\.some/);
  assert.match(overlaySource, /request\.status === "running"/);
  assert.match(overlaySource, /request\.status === "cancellation_requested"/);
  assert.match(overlaySource, /!resumeVoiceDraftRef\.current\.has\(draft\.requestId\)/);
  assert.match(overlaySource, /resumeVoiceDraftRef\.current\.add\(draft\.requestId\)/);
  assert.match(overlaySource, /\.finally\(\(\) => resumeVoiceDraftRef\.current\.delete\(draft\.requestId\)\)/);
  assert.match(overlaySource, /draft\?\.status === "transcript_ready"/);
  assert.match(overlaySource, /store\.settings\.jarvis\.voiceInput\.autoSubmitTranscript/);
  assert.match(overlaySource, /store\s*\.sendVoiceTranscript\(/);
});

test("hands-free Jarvis arms VAD automatically and mute is the primary microphone control", () => {
  assert.match(jarvisSettingsSource, /activationMode:\s*"vad"/);
  assert.match(jarvisSettingsSource, /ALWAYS_READY_ARM_SECONDS = 120/);
  assert.match(voiceTypesSource, /max_armed_seconds: self\.max_armed_seconds\.clamp\(1, 120\)/);
  assert.match(overlaySource, /const AUTO_ARM_DELAY_MS = 180/);
  assert.match(overlaySource, /settings\.jarvis\.voiceInput\.activationMode !== "vad"/);
  assert.match(overlaySource, /store\.startVoice\(\)/);
  assert.match(overlaySource, /toggleMicrophoneMuted/);
  assert.match(overlaySource, /voiceError && isVoiceConfigurationError\(voiceError\)/);
  assert.match(settingsSource, /clearVoiceError\(\)/);
  assert.match(widgetSource, /onToggleMuted/);
  assert.match(widgetSource, /MicOff/);
  assert.match(widgetSource, /workspaceName: string \| null/);
  assert.match(widgetSource, /Jarvis · \$\{statusLabel\}/);
  assert.match(widgetSource, /collapsedJarvisStatus\(/);
  assert.match(widgetSource, /aria-label=\{`Jarvis · \$\{statusLabel\}`\}/);
  assert.match(widgetSource, /role="status"/);
  assert.match(widgetSource, /aria-live="polite"/);
  assert.doesNotMatch(widgetSource, /statusText|helperText|jarvis-pill__helper|jarvis-pill__label/);
  assert.doesNotMatch(widgetSource, /Premi il microfono per riattivarlo|Pronto ad ascoltare|Sempre pronto|In ascolto · il silenzio invia automaticamente/);
  assert.match(widgetSource, /voiceRequest\?\.status === "armed"/);
  assert.match(widgetSource, /voiceRequest\?\.status === "recording"/);
  assert.match(widgetSource, /jarvis-control--muted/);
  assert.match(widgetSource, /className=\{`jarvis-pill[\s\S]*props\.muted \? "jarvis-pill--muted"/);
  assert.match(widgetSource, /props\.muted \? <MicOff/);
  assert.match(globalsSource, /\.jarvis-pill--muted\.jarvis-pill--listening/);
  assert.match(globalsSource, /\.jarvis-orb--muted\.jarvis-orb--speaking/);
});

test("hands-free ambient capture follows workspace focus without stealing an active spoken turn", () => {
  assert.match(overlaySource, /activeVoiceRequestId/);
  assert.match(overlaySource, /activeRequest\?\.status !== "armed"/);
  assert.match(overlaySource, /activeRequest\.workspaceId === activeWorkspaceId/);
  assert.match(overlaySource, /\.cancelVoice\(\)/);
  assert.match(overlaySource, /settings\.jarvis\.muted/);
});

test("Jarvis widget drag mirrors native release semantics instead of sticky pointer capture", () => {
  assert.match(widgetSource, /const DRAG_START_DISTANCE = 5/);
  assert.doesNotMatch(widgetSource, /DRAG_HOLD_MS|EARLY_MOVE_CANCEL_DISTANCE/);
  assert.match(widgetSource, /window\.addEventListener\("pointermove", handleMove/);
  assert.match(widgetSource, /window\.addEventListener\("pointerup", handleUp\)/);
  assert.match(widgetSource, /window\.addEventListener\("pointercancel", handleCancel\)/);
  assert.match(widgetSource, /window\.addEventListener\("blur", handleCancel\)/);
  assert.match(widgetSource, /const finish = \(persist: boolean\)/);
  assert.match(widgetSource, /cleanupListeners\(\)/);
  assert.doesNotMatch(
    widgetSource,
    /element\.setPointerCapture\(event\.pointerId\)/,
  );
});

test("modal traps keyboard focus and restores the previous control", () => {
  assert.match(modalSource, /FOCUSABLE_SELECTOR/);
  assert.match(modalSource, /previousFocusRef/);
  assert.match(modalSource, /event\.key !== "Tab"/);
  assert.match(modalSource, /aria-labelledby=\{titleId\}/);
  assert.match(modalSource, /previous\?\.isConnected/);
  assert.match(modalSource, /tabIndex=\{-1\}/);
});

test("persisted desktop layout rejects obsolete right-panel views", () => {
  assert.match(
    uiStoreSource,
    /RightPanelView = "browser" \| "files" \| "git" \| "skills" \| null/,
  );
  assert.match(uiStoreSource, /normalizeRightPanelView/);
  assert.match(uiStoreSource, /merge: \(persisted, current\)/);
  assert.match(uiStoreSource, /MIN_SIDEBAR_WIDTH = 260/);
  assert.match(uiStoreSource, /MAX_RIGHT_PANEL_WIDTH = 560/);
  assert.doesNotMatch(uiStoreSource, /RightPanelView = string/);
  assert.doesNotMatch(uiStoreSource, /\.\.\.saved,/);
});

test("persisted workspace presets are bounded before the wizard consumes them", () => {
  assert.match(presetStoreSource, /boundedTerminalCount/);
  assert.match(presetStoreSource, /Math\.max\(1, Math\.min\(8/);
  assert.match(presetStoreSource, /boundedAgentCounts/);
  assert.match(presetStoreSource, /merge: \(persisted, current\)/);
  assert.match(presetStoreSource, /filter\(\(preset\): preset is Preset/);
});

test("Git rows keep staged and worktree diff sides distinct", () => {
  assert.match(gitChangesSource, /interface SelectedGitRow/);
  assert.match(gitChangesSource, /function availableSide/);
  assert.match(gitChangesSource, /selectChange\(change, staged\)/);
  assert.match(gitChangesSource, /stagedRow \? "staged" : "worktree"/);
  assert.match(gitChangesSource, /selectedRow\.side === rowSide/);
});

test("Git drafts and destructive confirmations cannot leak across workspaces", () => {
  assert.match(
    gitChangesSource,
    /useEffect\(\(\) => \{\s*setCommitMessage\(""\);\s*setPendingDiscard\(null\);\s*setSelectedRow\(null\);\s*\}, \[workspaceId\]\)/s,
  );
});

test("late workspace loads cannot steal active terminal ownership", () => {
  assert.match(
    workspaceViewSource,
    /firstId\s*&&\s*useWorkspaceStore\.getState\(\)\.activeWorkspaceId === id[\s\S]*terminalStore\.setActiveTerminal\(firstId\)/,
  );
  assert.doesNotMatch(workspaceViewSource, /let cancelled = false/);
});

test("workspace config LRU is PTY-safe, active-safe and self-healing", () => {
  assert.match(workspaceViewSource, /This is only an LRU cache for workspace configuration/);
  assert.match(workspaceViewSource, /const activeAtCommit = useWorkspaceStore\.getState\(\)\.activeWorkspaceId/);
  assert.match(workspaceViewSource, /key !== activeAtCommit && key !== id && next\.has\(key\)/);
  assert.match(workspaceViewSource, /if \(toEvict\) next\.delete\(toEvict\)/);
  assert.doesNotMatch(
    workspaceViewSource,
    /terminalStore\.killWorkspaceTerminals\(toEvict\)/,
  );
  assert.match(
    workspaceViewSource,
    /!loadedMap\.has\(activeWorkspaceId\)[\s\S]*!loadingRef\.current\.has\(activeWorkspaceId\)[\s\S]*loadWorkspace\(activeWorkspaceId\)/,
  );
  assert.match(
    workspaceViewSource,
    /\[activeWorkspaceId, loadedMap, loadWorkspace\]/,
  );
});

test("frontend agent launch is deduplicated and rolls back after bounded write failures", () => {
  assert.match(agentLauncherSource, /MAX_LAUNCH_ATTEMPTS = 2/);
  assert.match(agentLauncherSource, /queuedTerminals = new Set<string>/);
  assert.match(agentLauncherSource, /this\.queuedTerminals\.has\(terminalId\)/);
  assert.match(agentLauncherSource, /rollbackLaunchState\(terminalId\)/);
  assert.match(agentLauncherSource, /agentLaunched: false/);
  assert.match(agentLauncherSource, /await invoke\("terminal_write"/);
});

test("compact Jarvis microphone meter has real geometry", () => {
  assert.match(widgetSource, /VoiceMeter/);
  assert.match(widgetSource, /voiceArmed \|\| voiceListening/);
  assert.match(globalsSource, /\.jarvis-level-meter > span[\s\S]*height: 17px/);
  assert.match(globalsSource, /transform-origin: center/);
  assert.match(globalsSource, /\[data-jarvis-dragging="true"\] \.jarvis-pill/);
});

test("normal Jarvis settings stay hands-free, localized and keep hold-to-talk reachable", () => {
  assert.match(settingsSource, /La voce è l'interfaccia principale/);
  assert.match(settingsSource, /Modalità di interazione/);
  assert.match(settingsSource, /Sempre in ascolto/);
  assert.match(settingsSource, /hold_to_talk/);
  assert.match(settingsSource, /Tieni premuto per parlare/);
  assert.match(settingsSource, /Comportamento scorciatoia/);
  assert.match(settingsSource, /Silenzio prima dell'invio \(ms\)/);
  assert.match(settingsSource, /Attesa massima della voce \(s\)/);
  assert.match(settingsSource, /vadPostSpeechMs/);
  assert.match(settingsSource, /maxArmedSeconds/);
  assert.doesNotMatch(settingsSource, /value: "click_toggle"/);
  assert.doesNotMatch(
    settingsSource,
    /Consenso audio|Consenso testo|Consenso contesto|Privacy consent|Text fallback/,
  );
});

test("owner mode is enforced without deleting hold-to-talk", () => {
  assert.match(jarvisSettingsSource, /privacyConsent: true/);
  assert.match(jarvisSettingsSource, /autoSubmitTranscript: true/);
  assert.match(jarvisSettingsSource, /\? "hold_to_talk" : "vad"/);
  assert.match(jarvisSettingsSource, /activationMode:\s*"vad"/);
  assert.match(rustSettingsSource, /fn enforce_owner_mode/);
  assert.match(rustSettingsSource, /privacy_consent = true/);
  assert.match(rustSettingsSource, /auto_submit_transcript = true/);
  assert.match(
    rustSettingsSource,
    /activation_mode != VoiceActivationMode::HoldToTalk/,
  );
});

test("skill rows retain stable accent colors without reverting the compact layout", () => {
  assert.match(skillsSource, /const SKILL_ACCENTS = \[/);
  assert.match(skillsSource, /#ffb84d/);
  assert.match(skillsSource, /#55d89b/);
  assert.match(skillsSource, /#72a8ff/);
  assert.match(skillsSource, /#ca89ff/);
  assert.match(skillsSource, /#ff858c/);
  assert.match(skillsSource, /const accent = getSkillAccent\(skill\.id\)/);
  assert.match(skillsSource, /backgroundColor: accent\.background/);
});

test("sidebar new workspace action stays compact, framed and localized", () => {
  assert.match(sidebarSource, /h-\[45px\]/);
  assert.match(sidebarSource, /Nuovo spazio/);
  assert.match(rightPanelSource, /right-rail-jarvis/);
  assert.match(rightPanelSource, /const toggleJarvis = \(\) =>/);
  assert.match(rightPanelSource, /jarvisEnabled \? hideJarvis\(\) : showJarvis\(\)/);
  assert.match(globalsSource, /\.right-rail-jarvis \{[\s\S]*background: transparent/);
  assert.match(globalsSource, /\.right-rail-jarvis--active \{[\s\S]*background: oklch\(0\.82 0\.14 82 \/ 0\.10\)/);
  assert.match(globalsSource, /\.jarvis-pill--muted \{[\s\S]*background: oklch\(0\.185 0\.006 85 \/ 0\.985/);
  assert.doesNotMatch(rightPanelSource, /Traflix Jarvis/);
  assert.doesNotMatch(sidebarSource, /right-rail-jarvis|toggleJarvis|showJarvis|hideJarvis|Sparkles/);
  assert.match(uiStoreSource, /rightPanelWidth: 420/);
  assert.match(uiStoreSource, /MIN_RIGHT_PANEL_WIDTH = 360/);
  assert.match(uiStoreSource, /MAX_RIGHT_PANEL_WIDTH = 560/);
  assert.match(uiStoreSource, /rightPanelLayoutVersion: RIGHT_PANEL_LAYOUT_VERSION/);
  assert.match(sidebarSource, /Spazi di lavoro/);
  assert.match(sidebarSource, /h-7 min-w-\[156px\] items-center justify-center gap-1\.5 rounded-md border border-white\/\[0\.10\]/);
  assert.doesNotMatch(sidebarSource, /New workspace|New space|Workspaces|No workspaces yet/);
});

test("workspace empty state keeps the terminal icon centered and uses Italian copy", () => {
  assert.match(workspaceViewSource, /w-full max-w-sm text-center tab-slide-in/);
  assert.match(workspaceViewSource, /<div className="flex justify-center">/);
  assert.match(workspaceViewSource, /Nessuno spazio di lavoro aperto/);
  assert.match(workspaceViewSource, /Seleziona uno spazio dalla barra laterale/);
  assert.match(workspaceViewSource, /Nuovo spazio/);
  assert.doesNotMatch(
    workspaceViewSource,
    /No workspace open|Select a workspace from the sidebar|New space/,
  );
});
