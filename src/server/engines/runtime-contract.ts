import type { EngineDriver, EngineEnvelope } from "../../shared/engine/contracts.js";
import type { HistoryQuery } from "../../shared/data-contracts.js";
import type { RpcRequest } from "../../shared/rpc-types.js";
export interface ReviewRecorder {
  record(input: { threadId?: unknown; turnId?: unknown; diff?: unknown }): void;
}
export interface SessionMetadata {
  id: string;
  cwd?: string;
  path?: string;
}
export interface SessionHistory {
  getThreadMetadata(threadId: string): Promise<SessionMetadata>;
  readConversationHistory(params: HistoryQuery): Promise<unknown>;
  readBrowserThread(params: HistoryQuery & { includeTurns?: boolean }): Promise<unknown>;
  readBrowserTurns(params: HistoryQuery & { itemsView?: string; sortDirection?: string }): Promise<unknown>;
  readLiveThread(threadId: unknown): Promise<unknown>;
  readComposerHistory(): Promise<Array<{ text: string }>>;
  subscribeSharedThread(value: unknown): Promise<void>;
  recordThreadStatus(threadId: string, status: unknown): void;
  recordFileChangeDiff(params: { threadId?: unknown; turnId?: unknown; changes?: unknown }): void;
  recordReviewDiffsFromRpc(method: string, params: { threadId?: string }, result: unknown): void;
  recordThreadPathsFromRpc(result: unknown): void;
  invalidateHistory(threadId: string): void;
  clearHistory(): void;
  dropSubscription(threadId: string): void;
  markSubscribed(threadId: string): void;
  clearSubscriptions(): void;
}
export interface EngineGoals {
  refresh(): void;
  emit(id: unknown): void;
  start(): void;
  stop(): void;
}
export interface EngineRecovery {
  onNotification(message: EngineEnvelope): void;
  onExplicitInput(id: unknown): void;
}
export interface InstalledEngine {
  driver: EngineDriver;
  request: RpcRequest;
  history: SessionHistory;
  goals: EngineGoals;
  recovery: EngineRecovery;
  recoverQueue(id: unknown): Promise<unknown>;
}
