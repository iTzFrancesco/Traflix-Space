export type RequestedDepth = "summary" | "last_result" | "full_messages";

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
  shell: string;
  cwd: string;
  active: boolean;
  processAlive: boolean;
  agentId?: string;
  provenance: Provenance;
}

export interface AgentSessionRef {
  agentSessionId: string;
  provider: string;
  workspaceId: string;
  terminalId?: string;
  providerSessionId?: string;
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
  objective?: string;
  state: AgentState;
  lastTurn?: AgentTurnContext;
  lastResult?: AgentResult;
  completionNotification?: AgentCompletionNotification;
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
