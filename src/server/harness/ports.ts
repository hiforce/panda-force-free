import type {
  HarnessAttachment,
  HarnessHistoryQuery,
  HarnessHistoryPage,
  HarnessCapabilities,
  HarnessHistoryEvent,
  HarnessModel,
  HarnessRuntime,
  HarnessMessage,
  HarnessPermissionMode,
  HarnessProtocol,
} from "../../shared/harness/contracts.js";
import type { TokenCount } from "../../shared/engine/types.js";
export type HarnessImportedMessage = Pick<HarnessMessage, "role" | "text"> &
  Partial<Pick<HarnessMessage, "id" | "runId" | "createdAt">>;
export interface HarnessSourcePage {
  cwd: string;
  title: string;
  history: HarnessImportedMessage[];
  cursor: string | null;
}

export interface HarnessRecord {
  id: string;
  kind: string;
  owner: string;
  revision: number;
  data: string;
  updatedAt: number;
}
export interface HarnessRecordList {
  limit: number;
  oldestFirst?: boolean;
  updatedThrough?: number;
}
export interface HarnessMetadataTransaction {
  get(id: string): Promise<HarnessRecord | null>;
  list(kind: string, owner?: string, page?: HarnessRecordList): Promise<HarnessRecord[]>;
  put(record: HarnessRecord, expectedRevision: number | null): Promise<void>;
  remove(id: string, expectedRevision: number): Promise<void>;
}
export interface HarnessMetadata {
  read(id: string): Promise<HarnessRecord | null>;
  list(kind: string, owner?: string, page?: HarnessRecordList): Promise<HarnessRecord[]>;
  transaction<T>(work: (transaction: HarnessMetadataTransaction) => Promise<T>): Promise<T>;
  close(): void | Promise<void>;
}
export interface HarnessHistory {
  reference(
    owner: string,
    conversationId: string,
    committedBytes: number,
  ): Promise<{
    uri: string;
    path: string;
    indexPath: string;
    committedBytes: number;
    format: string;
    timestampField: string;
    sequenceField: string;
    readOnly: true;
  }>;
  queryTime(
    owner: string,
    conversationId: string,
    committedBytes: number,
    input: HarnessHistoryQuery,
  ): Promise<HarnessHistoryPage>;
  window(
    owner: string,
    conversationId: string,
    committedBytes: number,
    options?: { beforeBytes?: number; maxBytes?: number },
  ): Promise<{ events: HarnessHistoryEvent[]; startBytes: number; truncated: boolean }>;
  scanUserMessages(
    owner: string,
    conversationId: string,
    committedBytes: number,
    afterBytes: number,
  ): Promise<{ messages: Array<{ message: HarnessMessage; throughBytes: number }>; nextBytes: number }>;
  messageAt(
    owner: string,
    conversationId: string,
    committedBytes: number,
    location: { messageId: string; recordedAt: number; throughBytes?: number },
  ): Promise<HarnessMessage | null>;
  read(owner: string, conversationId: string, committedBytes: number): Promise<HarnessHistoryEvent[]>;
  append(
    owner: string,
    conversationId: string,
    committedBytes: number,
    events: readonly HarnessHistoryEvent[],
  ): Promise<number>;
}
export interface HarnessAgentInfo {
  protocol?: HarnessProtocol;
  capabilities: HarnessCapabilities;
  models: HarnessModel[];
  currentModel: string | null;
  commands: string[];
}
export interface HarnessNativeSession {
  id: string;
  cwd: string;
  /** Authenticated session discovery can supersede the startup catalog. */
  info?: HarnessAgentInfo;
}
export type HarnessAgentEvent =
  | { type: "activity" }
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; name: string; status: "running" | "complete" | "error"; text?: string }
  | { type: "permission"; id: string; title: string; options: Array<{ id: string; name: string; kind: string }> };
export interface HarnessPrompt {
  text: string;
  attachments: Array<HarnessAttachment & { path: string }>;
  visualEvidence?: readonly HarnessVisualEvidence[];
  /** Invoke after configuration and encoding, immediately before the native send. */
  beforeDispatch?: () => Promise<void>;
  model: string | null;
  effort: string | null;
  operationId: string;
  continuation?: true;
}
export interface HarnessVisualEvidence {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
}
/** Native protocols terminate at these ports; application history never stores vendor RPC envelopes. */
export interface HarnessOpenOptions {
  permissionMode?: HarnessPermissionMode;
  model?: string | null;
  discoverModels?: boolean;
}

export interface HarnessAgent {
  initialize(): Promise<HarnessAgentInfo>;
  create(cwd: string, options?: HarnessOpenOptions): Promise<HarnessNativeSession>;
  load(id: string, cwd: string, options?: HarnessOpenOptions): Promise<HarnessNativeSession>;
  prompt(
    session: HarnessNativeSession,
    input: HarnessPrompt,
    emit: (event: HarnessAgentEvent) => Promise<void>,
  ): Promise<{ stopReason: "complete" | "cancelled"; usage?: TokenCount }>;
  cancel(session: HarnessNativeSession): Promise<void>;
  respondPermission(id: string, optionId: string | null): Promise<void>;
  close(): Promise<void>;
}
export interface HarnessAgentFactory {
  create(
    runtime: HarnessRuntime,
    scope: {
      owner: string;
      scopeId: string;
      cwd: string;
      application?: HarnessApplicationPolicy;
      permissionMode?: HarnessPermissionMode;
      persistentConversation?: boolean;
    },
  ): Promise<HarnessAgent>;
}

/** Operator-owned application policy cannot be supplied by conversation input. */
export interface HarnessApplicationPolicy {
  instructions: string;
  scope?: import("../engines/application-tools/runtime-port.js").ApplicationRuntimeScope;
  nativeOutput?: boolean;
  toolNames?: readonly string[];
  mcpServer: { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };
}
