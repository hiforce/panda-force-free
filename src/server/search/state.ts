import type {
  SearchScope,
  SearchSettings,
  SearchSourceDefinition,
  SearchBuildProgress,
} from "../../shared/search/contracts.js";
import type { IndexReference } from "./ports.js";
export interface ActiveSearchIndex {
  text: IndexReference | null;
  vector: IndexReference | null;
  analyzer: string;
  source: SearchSourceDefinition;
  sourceRevision: number;
  settingsRevision: number;
  embedding: string | null;
  textFingerprint: string | null;
  knowledgeCommit?: string;
  vectorInput?: string;
  invalidated?: boolean;
}
export interface RetiredSearchIndex {
  id: number;
  descriptor: string;
}
export interface SearchJobRow {
  key: string;
  source: string;
  owner: string;
  project: string;
  settings: string;
  revision: number;
  requested: number;
  state: string;
  attempts: number;
  token: string | null;
  leaseUntil: number | null;
  active: string | null;
  commitId: string | null;
  documentCount: number;
  failure: string | null;
  updatedAt: number;
}
export interface SearchLedger {
  get(scope: SearchScope): SearchJobRow | null;
  byKey(key: string): SearchJobRow | null;
  all(): SearchJobRow[];
  configure(scope: SearchScope, input: unknown, revision: number): SearchJobRow;
  wake(key: string, force?: boolean): void;
  invalidate(key: string, expected?: Pick<SearchJobRow, "active" | "revision" | "requested">): boolean;
  claim(sources?: readonly string[]): SearchJobRow | null;
  heartbeat(row: SearchJobRow): boolean;
  complete(row: SearchJobRow, active: ActiveSearchIndex, commit: string, count: number): boolean;
  fail(row: SearchJobRow, error: string): void;
  active(row: SearchJobRow): ActiveSearchIndex | null;
  settings(row: SearchJobRow): SearchSettings;
  retired(after?: number): RetiredSearchIndex[];
  forget(id: number): void;
  referencesUncertain?(): boolean;
  reconcileReferences?(): boolean;
  progress?(
    row: SearchJobRow,
    value: Pick<SearchBuildProgress, "completed" | "total"> & {
      phase: Exclude<SearchBuildProgress["phase"], "queued" | "ready" | "failed">;
    },
  ): boolean;
}
