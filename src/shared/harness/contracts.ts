import type { TokenUsage } from "../engine/types.js";

/** Runtime instances are deployment identities; conversations and model choices have separate lifetimes. */
export type HarnessKind = "codex" | "grok-build" | "zcode" | "antigravity" | "claude-code";
export type HarnessDeployment = "local" | "container" | "remote";
export type HarnessStatus = "unknown" | "connecting" | "ready" | "authentication" | "unavailable";
export type HarnessProtocol = "codex-app-server/model-list" | "acp/1" | "zcode-app-server/session-workspace";
export const HARNESS_PERMISSION_MODES = [
  "ask",
  "accept-edits",
  "plan",
  "always-approve",
  "deny-unapproved",
  "full-access",
] as const;
export type HarnessPermissionMode = (typeof HARNESS_PERMISSION_MODES)[number];
export function isHarnessPermissionMode(value: unknown): value is HarnessPermissionMode {
  return typeof value === "string" && (HARNESS_PERMISSION_MODES as readonly string[]).includes(value);
}
export interface HarnessRuntime {
  id: string;
  name: string;
  kind: HarnessKind;
  profileId: string;
  enabled: boolean;
  botEnabled?: boolean;
  archivedAt?: number;
  revision: number;
  defaultModel: string | null;
  defaultEffort: string | null;
  access: "administrators" | "members";
  createdAt: number;
  updatedAt: number;
}
export interface HarnessModel {
  id: string;
  name: string;
  isDefault?: boolean;
  defaultEffort?: string | null;
  efforts: Array<{ id: string; name: string }>;
  contextTokens?: number;
}
export interface HarnessCapabilities {
  text: boolean;
  imageInput: boolean;
  fileInput: boolean;
  tools: boolean;
  permissions: boolean;
  permissionModes?: HarnessPermissionMode[];
  load: boolean;
  models: boolean;
  imageGeneration: "unknown" | "verified";
}
export interface HarnessRuntimeView extends HarnessRuntime {
  botSupported?: boolean;
  creationCapabilities?: import("../creation/media-executors.js").HarnessCreationCapabilities;
  deployment: HarnessDeployment;
  status: HarnessStatus;
  isDefault: boolean;
  models: HarnessModel[];
  capabilities: HarnessCapabilities | null;
  protocol?: HarnessProtocol;
  error?: HarnessErrorCode;
}
export interface HarnessProfileView {
  id: string;
  name: string;
  kind: HarnessKind;
  deployment: HarnessDeployment;
}
export interface HarnessCatalog {
  revision: number;
  defaultRuntimeId: string;
  runtimes: HarnessRuntimeView[];
  profiles: HarnessProfileView[];
  canManage: boolean;
}
export interface HarnessPingResult {
  requestId: string;
  runtimeId: string;
  status: "complete" | "error" | "uncertain";
  reply: string;
  model: string | null;
  elapsedMs: number;
  error?: HarnessErrorCode;
}
export interface HarnessAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  bytes: number;
  url?: string;
}
export interface HarnessMessage {
  id: string;
  seq: number;
  runId: string;
  role: "user" | "assistant" | "tool";
  clientId?: string;
  runtimeId: string;
  model: string | null;
  text: string;
  attachments: HarnessAttachment[];
  status: "running" | "complete" | "cancelled" | "error" | "uncertain";
  createdAt: number;
  error?: HarnessErrorCode;
  sourceTimestampKnown?: boolean;
}
export interface HarnessConversation {
  id: string;
  owner: string;
  projectId: string | null;
  cwd: string;
  title: string;
  runtimeId: string;
  permissionMode?: HarnessPermissionMode;
  memoryPrivate?: true;
  revision: number;
  lastSeq: number;
  historyBytes: number;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
export interface HarnessBinding {
  runtimeId: string;
  nativeSessionId: string;
  scopeId: string;
  synchronizedSeq: number;
  configurationRevision: number;
}
export type HarnessRunStatus =
  "prepared" | "dispatching" | "running" | "complete" | "cancelled" | "error" | "uncertain";
export interface HarnessRun {
  id: string;
  conversationId: string;
  owner: string;
  requestId: string;
  requestDigest: string;
  runtimeId: string;
  model: string | null;
  effort: string | null;
  permissionMode?: HarnessPermissionMode;
  status: HarnessRunStatus;
  thinking?: boolean;
  epoch: string;
  leaseUntil: number;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: number;
  updatedAt: number;
  error?: HarnessErrorCode;
}
export type HarnessHistoryEvent = (
  | { type: "message"; seq: number; message: HarnessMessage }
  | { type: "text"; seq: number; messageId: string; text: string }
  | { type: "status"; seq: number; messageId: string; status: HarnessMessage["status"]; error?: HarnessErrorCode }
) & { runtimeId?: string; runId?: string };
export interface HarnessConversationSnapshot {
  conversation: Omit<HarnessConversation, "owner" | "historyBytes">;
  messages: HarnessMessage[];
  run: Pick<
    HarnessRun,
    "id" | "status" | "runtimeId" | "model" | "effort" | "thinking" | "error" | "createdAt" | "updatedAt"
  > | null;
  runtime: HarnessRuntimeView | null;
  tokenUsage?: TokenUsage;
  cursor: string;
  history: { beforeBytes: number; hasEarlier: boolean; nextCursor?: string | null };
}
export type HarnessErrorCode =
  | "invalidInput"
  | "notFound"
  | "forbidden"
  | "conflict"
  | "busy"
  | "unavailable"
  | "authentication"
  | "capabilityUnavailable"
  | "workspaceUnavailable"
  | "contextTooLarge"
  | "deliveryUncertain"
  | "leaseLost"
  | "invalidProtocol"
  | "timeout"
  | "historyCorrupt";
export class HarnessError extends Error {
  constructor(
    public readonly code: HarnessErrorCode,
    public readonly status = 400,
  ) {
    super(code);
  }
}

export interface HarnessPermission {
  id: string;
  title: string;
  options: Array<{ id: string; name: string; kind: string }>;
}
export interface HarnessHistoryQuery {
  from: number;
  to: number;
  query?: string;
  cursor?: { indexOffset: number; afterSeq?: number };
  limit?: number;
}
export interface HarnessHistoryMatch {
  seq: number;
  timestamp: string;
  type: string;
  messageId: string;
  runtimeId?: string;
  runId?: string;
  text: string;
  truncated: boolean;
}
export interface HarnessHistoryPage {
  records: HarnessHistoryMatch[];
  cursor: { indexOffset: number; afterSeq?: number } | null;
  complete: boolean;
}

export class HarnessPromptError extends HarnessError {
  constructor(
    code: HarnessErrorCode,
    readonly dispatched: boolean,
    status = 503,
  ) {
    super(code, status);
  }
}
