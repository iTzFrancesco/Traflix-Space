export type RequestedDepth = "summary" | "last_result" | "full_messages";

export type VoiceEngine = "standard" | "gemini_live";
export type ModelProvider = "codex";

export type CodexRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "failed";

export interface CodexRuntimeStatus {
  state: CodexRuntimeState;
  version: string | null;
  pid: number | null;
  codexHome: string | null;
  platform: string | null;
  startedAt: string | null;
  handshakeCompleted: boolean;
  lastError: string | null;
  restartCount: number;
}

export type CodexAccount =
  | { kind: "signedOut" }
  | { kind: "chatgpt"; email: string | null; planType: string }
  | { kind: "apiKey" }
  | { kind: "other"; accountType: string };

export interface CodexAccountView {
  account: CodexAccount;
  requiresOpenaiAuth: boolean;
}

export interface CodexLoginStartView {
  authUrl: string;
  loginId: string;
}

export interface CodexAccountEvent {
  method: string;
  params: unknown;
}


export interface WidgetPosition {
  x: number;
  y: number;
}

export interface StandardPipelineSettings {
  stt: string;
  fastModel: string;
  contextPlanner: string;
  tts: string;
  voice: string;
}

export interface GeminiLiveSettings {
  provider: string;
  model: string;
  voice: string;
  automaticTurnDetection: boolean;
  allowInterruption: boolean;
}

export interface JarvisSettings {
  enabled: boolean;
  voiceEngine: VoiceEngine;
  muted: boolean;
  wakeWordEnabled: boolean;
  wakeWordPhrase: string;
  wakeWordSensitivity: number;
  widgetPosition: WidgetPosition;
  standardPipeline: StandardPipelineSettings;
  geminiLive: GeminiLiveSettings;
  textModel: TextModelSettings;
  codex: CodexModelSettings;
  voiceInput: VoiceInputSettings;
  voiceOutput: VoiceOutputSettings;
}

export interface CodexModelSettings {
  model: string;
  reasoningEffort: string;
  /** C8: speak completed commentary/final items progressively. */
  speakCommentary: boolean;
}

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string | null;
}

export interface CodexModelInfo {
  id: string;
  displayName?: string | null;
  isDefault: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts: CodexReasoningEffort[];
}

export interface CodexModelCatalog {
  data: CodexModelInfo[];
}

export interface CodexUsageView {
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  currentStreakDays?: number | null;
  longestStreakDays?: number | null;
}

export interface CodexRateLimitsView {
  snapshot: unknown;
}

export interface JarvisCodexThread {
  threadId: string;
  workspaceId: string;
  model: string;
  reasoningEffort: string;
  createdAt: number;
  status: "idle" | "in_progress" | string;
  activeTurnId: string | null;
}

export interface CodexThreadSnapshot {
  threads: JarvisCodexThread[];
}

// C7 — streaming conversation (jarvis://chat-stream).

export type CodexChatStreamKind =
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_interrupted"
  | "message_started"
  | "message_delta"
  | "message_completed"
  | "tool_started"
  | "tool_completed";

/** One normalized streaming event emitted by the backend bridge. */
export interface CodexChatStreamEvent {
  kind: CodexChatStreamKind;
  requestId: string | null;
  workspaceId: string | null;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  text: string | null;
  toolName: string | null;
  timestamp: string;
}

/** One visible item of a streaming turn (message or tool lifecycle). */
export interface CodexStreamItem {
  itemId: string;
  kind: "message" | "tool";
  status: "started" | "active" | "completed";
  /** Accumulated agent message text (commentary/final). */
  text: string;
  toolName: string | null;
  /** Marked on the last completed message before turn/completed (correction #4). */
  final: boolean;
  updatedAt: string;
}

/** One streaming Codex turn of a workspace. */
export interface CodexStreamingTurn {
  turnId: string;
  threadId: string;
  requestId: string | null;
  workspaceId: string;
  status: "active" | "completed" | "failed" | "interrupted";
  items: CodexStreamItem[];
  startedAt: string;
  endedAt: string | null;
}

/** C8: one completed commentary/final item waiting for Edge TTS. */
export interface CodexSpeechItem {
  itemId: string;
  turnId: string;
  workspaceId: string;
  text: string;
}

export type VoiceActivationMode = "click_toggle" | "hold_to_talk" | "vad" | "wake_word";
export type ShortcutBehavior = "toggle" | "hold";

export interface VoiceInputSettings {
  enabled: boolean;
  provider: "groq";
  model: "whisper-large-v3-turbo" | string;
  language: string;
  maxDurationSeconds: number;
  selectedInputDeviceId?: string | null;
  autoSubmitTranscript: boolean;
  privacyConsent: boolean;
  privacyConsentAt?: string;
  activationMode: VoiceActivationMode;
  globalShortcutEnabled: boolean;
  globalShortcut: string;
  shortcutBehavior: ShortcutBehavior;
  vadEnabled: boolean;
  vadSpeechThreshold: number;
  vadStartFrames: number;
  vadSilenceFrames: number;
  vadPreRollMs: number;
  vadPostSpeechMs: number;
  endpointingEnabled: boolean;
  endpointGraceMs: number;
  minSpokenMs: number;
  maxArmedSeconds: number;
}

export interface VoiceOutputSettings {
  enabled: boolean;
  provider: "edge_tts";
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  autoSpeak: boolean;
  maxSpokenChars: number;
  privacyConsent: boolean;
  privacyConsentAt?: string;
  stopOnUserSpeech: boolean;
}

export interface TextModelSettings {
  privacyConsent: boolean;
  privacyConsentAt?: string;
}

export interface AppSettings {
  sidebar: {
    isCollapsed: boolean;
    workspaceOrder: string[];
    activeWorkspaceId: string | null;
  };
  theme: {
    accentColor: string;
  };
  jarvis: JarvisSettings;
}

export type VoiceRequestStatus = "idle" | "armed" | "recording" | "stopping" | "transcribing" | "transcript_ready" | "cancelled" | "failed";
export interface VoiceInputDevice { id: string; name: string; isDefault: boolean; available: boolean; }
export interface VoiceErrorView { code: string; message: string; }
export type WakeWordState = "off" | "standby" | "listening" | "unavailable" | "error";
export interface WakeWordStatusView {
  state: WakeWordState;
  enabled: boolean;
  keyword: string;
  engine: string;
  score?: number;
  error?: VoiceErrorView;
}
export interface VoiceRequestStatusView { requestId: string; workspaceId: string; selectedDeviceId?: string; status: VoiceRequestStatus; createdAt: string; startedAt?: string; durationMs?: number; normalizedLevel: number; transcript?: string; error?: VoiceErrorView; activationMode: VoiceActivationMode; vadState: VadState; }
export type VoiceSubmitState = "manual" | "queued" | "submitting" | "sent";
export type VadState = "silence" | "maybe_speech" | "speech";
export interface VoiceLevelEvent { requestId: string; elapsedMs: number; normalizedLevel: number; vadState: VadState; }
export type TtsStatus = "idle" | "synthesizing" | "playing" | "stopped" | "failed";
export interface TtsStatusView { requestId?: string; workspaceId?: string; sequence?: number; status: TtsStatus; error?: VoiceErrorView; }
export interface TtsVoice { shortName: string; locale: string; gender?: string; }
export interface TtsSpeakRequest { requestId: string; workspaceId?: string; text: string; voice?: string; rate?: string; volume?: string; pitch?: string; }

export type CacheStatus = "miss" | "hit" | "incremental" | "invalidated";

export type AgentState =
  | "starting"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted"
  | "exited"
  | "unknown";

export interface InvocationBinding {
  requestId: string;
  targetWorkspaceId: string;
  targetTerminalId?: string;
  targetAgentSessionId?: string;
  createdAt: string;
}

export interface Provenance {
  source: string;
  observedAt: string;
  confidence: number;
  untrusted: boolean;
}

export interface DocumentationEntry {
  relativePath: string;
  modifiedAt: string;
  contentHash: string;
  content: string;
  truncated: boolean;
  untrusted: boolean;
}

export interface OmittedDocument {
  relativePath: string;
  reason: string;
}

export interface DocumentationContext {
  workspaceId: string;
  workspaceRoot: string;
  generatedAt: string;
  revision: string;
  cacheStatus: CacheStatus;
  documents: DocumentationEntry[];
  omittedDocuments: OmittedDocument[];
  warnings: string[];
}

export interface DocumentationIndexEntry {
  relativePath: string;
  modifiedAt: string;
  contentHash: string;
  truncated: boolean;
  untrusted: boolean;
}

export interface DocumentationSummary {
  workspaceId: string;
  revision: string;
  cacheStatus: CacheStatus;
  documentCount: number;
  omittedCount: number;
  truncatedCount: number;
  warningCount: number;
}

export interface DocumentationExcerpt {
  relativePath: string;
  contentHash: string;
  content: string;
  truncated: boolean;
  untrusted: boolean;
}

export interface TerminalSummary {
  terminalId: string;
  workspaceId: string;
  /** User-controlled title; Jarvis treats it as a read-only semantic hint. */
  title: string;
  /** Stable internal identity; never use title as an authorization key. */
  agentAlias?: string | null;
  shell: string;
  cwd: string;
  active: boolean;
  processId: number | null;
  processAlive: boolean;
  agentId?: string;
  configuredAgentId?: string;
  observedProvider?: string;
  resolvedProvider: string;
  detectionSource: string;
  detectionConfidence: number;
  identityWarnings: string[];
  generation: number;
  provenance: Provenance;
}

export interface AgentTail {
  workspaceId: string;
  terminalId: string;
  generation: number;
  content: string;
  maxLines: number;
  maxBytes: number;
  truncated: boolean;
  provenance: Provenance;
}

export interface AgentOpenResult {
  provider: string;
  terminalId: string;
  generation: number;
  initialPromptSent: boolean;
  agentAlias: string;
  agentSessionId: string;
  assignmentId?: string;
  dispatchStatus?:
    | "pty_write_accepted"
    | "prompt_submitted"
    | "turn_started"
    | "submission_unconfirmed"
    | "turn_failed";
  dispatchStages: Array<
    | "pty_write_accepted"
    | "prompt_submitted"
    | "turn_started"
    | "submission_unconfirmed"
    | "turn_failed"
  >;
}

export interface AgentAssignmentBinding {
  assignmentId: string;
  agentAlias: string;
  agentSessionId: string;
  terminalId: string;
  generation: number;
  processId: number | null;
  provider: string;
  providerSessionId?: string;
}

export interface AgentRecipientReceipt extends AgentAssignmentBinding {
  displayTitle: string;
}

export type AgentInteractionSource = "user" | "jarvis" | "system";

export type AgentActivityKind =
  | "prompt_submitted"
  | "working"
  | "completion_observed"
  | "result_available"
  | "interrupted"
  | "exited";

/** Current operational task of an agent session, reconstructed from the shared visible PTY. */
export interface AgentTaskContext {
  text: string;
  source: AgentInteractionSource;
  startedAt: string;
  completedAt?: string;
  confidence: number;
  untrusted: boolean;
}

/** One bounded event of the semantic activity timeline of an agent session. */
export interface AgentActivityEvent {
  id: string;
  kind: AgentActivityKind;
  source: AgentInteractionSource;
  occurredAt: string;
  textExcerpt?: string;
  confidence: number;
  untrusted: boolean;
}

export interface AgentSessionRef {
  agentSessionId: string;
  provider: string;
  configuredAgentId?: string;
  observedProvider?: string;
  resolvedProvider: string;
  detectionSource: string;
  detectionConfidence: number;
  identityWarnings: string[];
  identityNeedsConfirmation: boolean;
  workspaceId: string;
  terminalId?: string;
  agentAlias?: string;
  terminalTitle?: string;
  generation: number;
  providerSessionId?: string;
  providerTurnId?: string;
  createdAt: string;
  updatedAt: string;
  currentTask?: AgentTaskContext;
  lastActivityAt?: string;
}

export interface AgentTurnContext {
  turnId?: string;
  state: AgentState;
  objective?: string;
  occurredAt?: string;
  untrusted: boolean;
}

export interface AgentResult {
  content: string;
  truncated: boolean;
  untrusted: boolean;
  provenance: Provenance;
}

export interface AgentCompletionNotification {
  eventId?: string;
  observedAt: string;
  resultAvailable: boolean;
  untrusted: boolean;
}

export interface AgentMessage {
  role: string;
  content: string;
  turnId?: string;
  createdAt: string;
  untrusted: boolean;
}

export interface AgentSessionContext {
  ref: AgentSessionRef;
  configuredAgentId?: string;
  observedProvider?: string;
  resolvedProvider: string;
  detectionSource: string;
  detectionConfidence: number;
  identityWarnings: string[];
  identityNeedsConfirmation: boolean;
  objective?: string;
  state: AgentState;
  lastTurn?: AgentTurnContext;
  lastResult?: AgentResult;
  completionNotification?: AgentCompletionNotification;
  currentTask?: AgentTaskContext;
  lastActivityAt?: string;
  messages?: AgentMessage[];
  provenance: Provenance;
  confidence: number;
  warnings: string[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootPath: string;
  terminalCount: number;
  agentCount: number;
  updatedAt: string;
}

export interface ContextPackageV1 {
  packageVersion: string;
  invocation: InvocationBinding;
  documentation: DocumentationContext;
  terminals: TerminalSummary[];
  agentSessions: AgentSessionContext[];
  requestedDepth: RequestedDepth;
  warnings: string[];
}

export interface ModelContextViewV1 {
  viewVersion: string;
  invocation: InvocationBinding;
  documentationSummary: DocumentationSummary;
  documentIndex: DocumentationIndexEntry[];
  documentationExcerpts: DocumentationExcerpt[];
  terminals: TerminalSummary[];
  agentSessions: AgentSessionContext[];
  requestedDepth: RequestedDepth;
  provenance: Provenance;
  warnings: string[];
}

export interface ToolEnvelope<T> {
  data: T;
  provenance: Provenance;
  warnings: string[];
}

export interface JarvisErrorEnvelope {
  code: string;
  message: string;
  requestId?: string;
  workspaceId?: string;
  provenance: Provenance;
}

export interface ActiveWorkspaceCapture {
  workspaceId: string | null;
  capturedAt: string;
  provenance: Provenance;
}

export type ChatRole = "user" | "assistant";

export interface JarvisConversationMessage {
  id: string;
  role: ChatRole;
  content: string;
  workspaceId: string;
  createdAt: string;
  provider?: string;
  untrusted?: boolean;
}

export type PendingActionStatus = "pending" | "confirmed" | "rejected" | "expired" | "failed";

export interface PendingAction {
  id: string;
  operation: string;
  description: string;
  preview: string;
  editableText?: string;
  invocation: InvocationBinding;
  terminalId?: string;
  generation?: number;
  provider?: string;
  status: PendingActionStatus;
  createdAt: string;
  expiresAt: string;
}

export interface JarvisChatResponse {
  invocation: InvocationBinding;
  message: JarvisConversationMessage;
  provider: string;
  modelUsed: string;
  primaryModel: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  pendingActions: PendingAction[];
  uiIntents: JarvisUiIntent[];
  followUps: string[];
  warnings: string[];
}

export interface JarvisUiIntent {
  id: string;
  kind: "open_terminal";
  workspaceId: string;
  terminalId: string;
  generation: number;
  label: string;
}

export interface JarvisProviderStatus {
  provider: ModelProvider;
  primaryModel: string;
  fallbackModel: string;
  configured: boolean;
  fallbackEnabled: boolean;
  privacyConsent: boolean;
  privacyConsentAt?: string;
  primaryModelAvailable: boolean;
  circuitBreakerUntil?: string;
  circuitBreakerReason?: string;
}

export type JarvisRequestStatus = "running" | "cancellation_requested" | "completed" | "failed" | "cancelled";

export interface JarvisRequestState {
  requestId: string;
  workspaceId: string;
  createdAt: string;
  status: JarvisRequestStatus;
  error?: string;
}

export interface NotificationAdapterStatus {
  provider: string;
  installed: boolean;
  path: string;
  detail: string;
}

export interface NotificationAdapterHealth {
  ready: boolean;
  bridgeAvailable: boolean;
  adapters: NotificationAdapterStatus[];
  restartRequired: boolean;
  message: string;
}
