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
  assert.match(uiStoreSource, /MAX_RIGHT_PANEL_WIDTH = 520/);
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

test("compact Jarvis microphone meter has real geometry", () => {
  assert.match(widgetSource, /VoiceMeter/);
  assert.match(globalsSource, /\.jarvis-level-meter > span[\s\S]*height: 12px/);
  assert.match(globalsSource, /transform-origin: center/);
  assert.match(globalsSource, /\[data-jarvis-dragging="true"\] \.jarvis-pill/);
});

test("normal Jarvis settings remain voice-first without old consent UI", () => {
  assert.match(settingsSource, /Voice is the default interface/);
  assert.match(
    settingsSource,
    /Turn detection, transcript submission and spoken replies are automatic/,
  );
  assert.doesNotMatch(
    settingsSource,
    /Consenso audio|Consenso testo|Consenso contesto|Privacy consent|Text fallback/,
  );
});
