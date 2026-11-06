import type { DataView } from "../../shared/data-view.js";
import type { ComposerAttachment, Suggestion } from "../../shared/data-contracts.js";
import type {
  Conversation,
  EngineItem,
  EngineTurn,
  ProjectVisibility,
  SessionSummary,
} from "../../shared/engine/types.js";
export interface ComposerDraft {
  text: string;
  mentions: readonly Suggestion[];
  attachments: readonly ComposerAttachment[];
}
export interface HistoryEntry {
  text: string;
  mentions?: readonly Suggestion[];
  attachments?: readonly ComposerAttachment[];
}
export interface ComposerHistory {
  reset(): void;
  setPersistent(entries: readonly HistoryEntry[]): void;
  setReplay(entries: readonly HistoryEntry[]): void;
  record(entry: HistoryEntry): void;
  navigate(direction: number, text: string, start: number, end?: number): HistoryEntry | null;
}
export interface DraftRepository {
  readonly composerHistory: ComposerHistory;
  loadComposerHistory(): Promise<void>;
  persistComposerDraft(): void;
  clearComposerDraft(threadId?: string): void;
  getComposerDraft(threadId?: string): ComposerDraft | undefined;
  setComposerDraft(threadId: string, draft: ComposerDraft): void;
  updateAttachment(id: string, patch: Partial<ComposerAttachment>): void;
}
export interface SessionRepository {
  recordTokenUsage(threadId: string, value: unknown, receivedAt?: number): void;
  replaceActive(thread: DataView<SessionSummary> | null): void;
  replaceThreads(threads: readonly DataView<SessionSummary>[]): void;
  setTurns(turns: readonly DataView<EngineTurn>[]): void;
  addSummary(thread: DataView<SessionSummary>): void;
  upsertSummary(thread: DataView<SessionSummary>): void;
  removeSummary(id: string): void;
}
export interface SidebarSnapshot {
  threads: DataView<SessionSummary>[];
  home: string;
  visibility?: DataView<ProjectVisibility>;
}
export interface ProjectionPayloads {
  sessionWorkspace: undefined;
  composerPlaceholder: undefined;
  workspaceContext: undefined;
  accountMenu: boolean | undefined;
  item: { item: DataView<EngineItem>; turnId: string; root?: HTMLElement; live?: boolean };
  workbench: undefined;
  sidebar: undefined;
  header: undefined;
  details: undefined;
  review: undefined;
  goals: string | undefined;
  status: undefined;
  contextUsage: undefined;
  composerSubmit: undefined;
  composerLayout: undefined;
  composerDraft: undefined;
  conversation: { thread: DataView<Conversation>; loadMore?: number };
  sideTasks: undefined;
  pendingMessages: undefined;
  approvals: undefined;
  approvalMenu: undefined;
  sessionOpened: string;
  newTask: undefined;
}
export interface ProjectionUpdates {
  request<K extends keyof ProjectionPayloads>(
    target: K,
    ...args: undefined extends ProjectionPayloads[K]
      ? [payload?: ProjectionPayloads[K]]
      : [payload: ProjectionPayloads[K]]
  ): void;
  attach(handlers: { [K in keyof ProjectionPayloads]: (payload: ProjectionPayloads[K]) => void }): void;
}
export interface ConversationRepository {
  remember(thread: DataView<SessionSummary> | null, options?: { persisted?: boolean }): void;
  load(id: string): Promise<Conversation | null>;
  forget(id: string): void;
  prune(): Promise<void>;
  has(id?: string): boolean;
  get(id: string): Conversation | null;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  summaries(): Promise<SessionSummary[] | null>;
  saveSummaries(rows: readonly DataView<SessionSummary>[]): Promise<void>;
}
export interface SidebarRepository {
  read(): SidebarSnapshot | null;
  saveThreads(threads: readonly DataView<SessionSummary>[], home?: string): void;
  saveVisibility(visibility: DataView<ProjectVisibility>): void;
  remove(id: string): void;
  clear(options?: { disableWrites?: boolean }): void;
}
export interface PersistentConversationRepository {
  close(): void;
  get(id: string): Promise<Conversation | null>;
  put(thread: DataView<SessionSummary> | null): Promise<void>;
  summaries(): Promise<SessionSummary[] | null>;
  saveSummaries(threads: readonly DataView<SessionSummary>[]): Promise<void>;
  prune(): Promise<string[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}
