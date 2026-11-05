import type { ComposerAttachment, DiffFile, Suggestion } from "../../shared/data-contracts.js";
import type {
  Conversation,
  EngineItem,
  EngineModel,
  EngineTurn,
  Goal,
  PermissionProfile,
  PublicAccount,
  RequestId,
  SessionSettings,
  SessionSummary,
  TokenUsage,
  WorkspaceConfiguration,
  WorkspaceContext,
} from "../../shared/engine/types.js";

export interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  method?: string;
}
export interface TurnTiming {
  started?: number;
  completed?: number;
}
export interface TurnWindow {
  threadId?: string;
  start: number;
  hiddenCount: number;
  visible: EngineTurn[];
}
export interface SideTask {
  threadId: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  status?: string;
  message?: string;
  agentPath?: string;
}
export interface ReviewModel {
  hasChanges: boolean;
  fileCount: number;
  linesAdded: number;
  linesDeleted: number;
  files: DiffFile[];
  turnId?: string;
  raw?: string;
  source?: string;
}
export interface PersistentNotice {
  id: string;
  key: string;
  message: string;
}
export interface FileChangeSummary {
  additions?: number;
  deletions?: number;
}

/** Fields describe application state independently of stores or feature factories. */
export interface ApplicationState {
  ws: WebSocket | null;
  events: EventSource | null;
  transport: "connecting" | "ws" | "sse";
  wsFallbackTimer: ReturnType<typeof setTimeout> | null;
  rpcId: number;
  pending: Map<RequestId, PendingRpc>;
  connected: boolean;
  threads: SessionSummary[];
  active: Conversation | null;
  config: WorkspaceConfiguration;
  workspaceContext: WorkspaceContext | null;
  newSessionProjectId: string | null;
  projectless: boolean;
  composerMode: string;
  planMode: boolean;
  composerMentions: Suggestion[];
  composerAttachments: ComposerAttachment[];
  models: EngineModel[];
  modelLoadStatus: "loading" | "ready" | "error";
  selectedModel: string;
  permissionMode: string;
  permissionProfiles: PermissionProfile[];
  permissionVisibility: { autoReview: boolean; fullAccess: boolean };
  sessionSettings: Map<string, SessionSettings>;
  goalMode: boolean;
  goals: Map<string, Goal>;
  tokenUsage: Map<string, TokenUsage>;
  turnWindow: TurnWindow | null;
  items: Map<string, HTMLElement>;
  turns: Map<string, HTMLElement>;
  turnTimings: Map<string, TurnTiming>;
  activities: Map<string, HTMLElement>;
  activityItems: Map<string, Map<string, EngineItem>>;
  sideTasks: Map<string, SideTask>;
  dividers: Map<string, HTMLElement>;
  changes: Map<string, FileChangeSummary>;
  turnDiffs: Map<string, ReviewModel>;
  activeReview: ReviewModel | null;
  requestCards: Map<RequestId, HTMLElement>;
  account: PublicAccount | null;
  persistentErrors: PersistentNotice[];
  backgroundAgentsVisible: boolean;
  cloudStartingState: string | null;
  placeholderText: string | null;
}
