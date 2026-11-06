import type { NativeInput, ProductProject } from "../data-contracts.js";

export type EngineId = string;
export type RequestId = string | number;
export type Timestamp = string | number | Date;
export interface EngineError {
  message: string;
  code?: string;
  turnId?: string;
}
export interface SessionStatus {
  type: string;
  error?: string | EngineError;
  failure?: string | EngineError;
}
export interface ContentPart {
  type: string;
  text?: string;
  url?: string;
  path?: string;
  name?: string;
  imageUrl?: string;
  data?: string;
  mimeType?: string;
}
export interface FileChange {
  path: string;
  filePath?: string;
  kind?: string | { type: string; movePath?: string };
  type?: string;
  diff?: string;
  unified_diff?: string;
  additions?: number;
  deletions?: number;
}
export interface ToolOutput {
  aggregatedOutput?: string;
  exitCode?: number | null;
  content?: ContentPart[];
}
export interface EngineItem {
  id: string;
  type: string;
  phase?: string;
  text?: string;
  content?: ContentPart[];
  summary?: string | ContentPart[];
  command?: string;
  terminalInputBuffer?: string;
  commandActions?: Array<{ command?: string; type?: string }>;
  aggregatedOutput?: string;
  output?: string | unknown[] | ToolOutput;
  exitCode?: number | null;
  executionStatus?: string;
  status?: string;
  changes?: FileChange[];
  name?: string;
  role?: string;
  server?: string;
  tool?: string;
  arguments?: string | Record<string, unknown>;
  result?: unknown;
  error?: string | EngineError;
  plan?: Array<{ step: string; status: string }>;
  explanation?: string;
  durationMs?: number;
  excludedTurns?: string[];
  receivedAt?: Timestamp;
  sentAt?: Timestamp;
  createdAt?: Timestamp;
  createdAtMs?: number;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  steer?: boolean;
  clientId?: string;
  owner?: string;
  turnId?: string;
  delivery?: string;
  submissionToken?: symbol;
  agentThreadId?: string;
  agentPath?: string;
  receiverThreadIds?: string[];
  agentsStates?: Record<string, { status?: string; message?: string }>;
  model?: string;
  reasoningEffort?: string;
  prompt?: string;
  questionState?: string;
  url?: string;
  imageUrl?: string;
  path?: string;
  revisedPrompt?: string;
  kind?: string;
  callId?: string;
  native?: unknown;
}
export interface EngineTurn {
  id: string;
  status: string;
  items: EngineItem[];
  error?: string | EngineError;
  failure?: string | EngineError;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
}
export interface ConversationHistory {
  revision?: string;
  oldestItemId?: string | null;
  nextCursor?: string | null;
  reset?: boolean;
  removedItems?: boolean;
  unchanged?: boolean;
  mode?: string;
  removedItemIds?: string[];
  questionTurns?: EngineTurn[];
  turns?: EngineTurn[];
  totalItems?: number;
  totalTurns?: number;
}
export interface SessionSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  source?: string;
  sideTask?: boolean;
  projectless?: boolean;
  status?: SessionStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  recencyAt?: Timestamp;
  lastActivityAt?: number;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  effort?: string;
  threadSettings?: SessionSettings;
  error?: string | EngineError;
  failure?: string | EngineError;
  lastError?: EngineError;
  canAcceptDirectInput?: boolean;
  turns?: EngineTurn[];
  history?: ConversationHistory;
  tokenUsage?: TokenUsage;
}
export interface Conversation extends SessionSummary {
  turns: EngineTurn[];
}
export interface SessionSettings {
  model?: string;
  effort?: string;
  reasoningEffort?: string;
  source?: string;
}
export interface EngineModel {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
}
export interface PermissionProfile {
  id: string;
  description?: string;
  allowed?: boolean;
}
export interface PermissionPolicy {
  permissions?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandbox?: string;
  sandboxPolicy?: {
    type: string;
    writableRoots?: string[];
    networkAccess?: boolean;
    excludeTmpdirEnvVar?: boolean;
    excludeSlashTmp?: boolean;
  };
}
export interface PermissionChoice extends PermissionPolicy {
  mode: string;
  label: import("../i18n/messages.js").MessageId;
  kind?: string;
  profileId?: string;
}
export interface Goal {
  threadId: string;
  goalId: string;
  status: string;
  objective: string;
  detail?: string;
  message?: string;
  updatedAt?: number;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  progress?: { completed?: number; total?: number; percent?: number; kind?: string; elapsedSeconds?: number };
}
export interface TokenCount {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  cacheWriteInputTokens?: number;
}
export interface TokenUsage {
  /** Provider observation time in Unix milliseconds, used to reject older snapshots. */
  updatedAt?: number;
  modelContextWindow?: number;
  total?: TokenCount;
  last?: TokenCount;
}
export interface PublicAccount {
  displayName: string | null;
  avatarUrl: string | null;
  planType: string | null;
  initials: string;
  type?: string;
  email?: string;
}
export interface WorkspaceConfiguration {
  engine?: import("./primitives.js").EngineDescriptor;
  home: string;
  defaultCwd: string;
  projectless: boolean;
  browseRoots?: string[];
  attachmentUrlPrefix?: string;
}
export interface WorkspaceContext {
  cwd: string;
  project: string;
  environment: string;
  branch: string | null;
}
export interface ProjectAssignment {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  updatedAt: number;
}
export interface ProjectSnapshot {
  revision: number;
  projects: ProductProject[];
  assignments: ProjectAssignment[];
}
export interface ProjectVisibility {
  revision: number;
  hiddenProjects: Record<string, { hiddenAt: number }>;
}
export interface PendingMessage extends EngineItem {
  owner: string;
  turnId: string;
  content: ContentPart[];
  submissionToken?: symbol;
}
export interface ApprovalRequest {
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
  originalMethod?: string;
}
export interface GoalCommand {
  command: string;
  objective?: string;
}
export interface SessionInput {
  cwd: string;
  model: string;
  input?: readonly NativeInput[];
}
