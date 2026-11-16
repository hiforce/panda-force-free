/** Search projections are disposable. Source versions and access remain owned by content services. */
import type { SavedSourceKind } from "../content-sources/contracts.js";
export type TextSearchProvider = "local" | "elasticsearch";
export type SearchMode = "text" | "semantic" | "hybrid";
export type SearchBuildPhase =
  "queued" | "reading" | "text" | "knowledge" | "vector" | "activating" | "ready" | "failed";
export interface SearchBuildProgress {
  job: string;
  phase: SearchBuildPhase;
  completed: number;
  total: number | null;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
}
export interface AnalyzerPackage {
  schema: 1;
  kind: "panda-search-analyzer";
  id: string;
  version: string;
  name: string;
  languages: string[];
  tokenizer: "unicode" | "segmenter";
  locale: string;
  stemming: "none" | "porter2";
  stopWords: string[];
}
export interface SearchSettings {
  enabled: boolean;
  fulltext: boolean;
  vector: boolean;
  analyzer: string;
  include: string[];
  exclude: string[];
  knowledge: KnowledgeRules;
  contentKinds?: SavedSourceKind[];
}
export interface ProjectSearchPolicySummary {
  shared: boolean;
  needsReview: boolean;
  previous: number;
}
export interface PreviousSearchSettingsPage {
  items: {
    id: string;
    owner: string;
    revision: number;
    updatedAt: number;
    settings: SearchSettings | null;
  }[];
  nextOffset: number | null;
}
export interface KnowledgeRules {
  mode: "manual" | "selected" | "project";
  documents: string[];
  subtrees: string[];
  exclude: string[];
}
export interface SearchDocument {
  id: string;
  title: string;
  text: string;
  version: string;
  locale: string;
  path: string;
  updatedAt: number;
  ancestors: string[];
  kind?: SavedSourceKind;
}
export interface SearchScope {
  owner: string;
  project: string;
  source: string;
}
/** Every content read carries an explicit selection; authorization remains independent of that selection. */
export interface SearchReadScope extends SearchScope {
  contentKinds: readonly SavedSourceKind[];
}
export interface SearchEmbeddingUsage {
  calls: number;
  callLimit: number;
  characters: number;
  characterLimit: number;
  resetsAt: number;
}
export interface SearchSourceDefinition {
  id: string;
  name: string;
  kind: TextSearchProvider;
  connection: string | null;
  knowledge: string | null;
  enabled: boolean;
  revision: number;
}
export interface SearchSnapshot {
  commit: string;
  documents: SearchDocument[];
}
interface SearchHitValue {
  id: string;
  title: string;
  snippet: string;
  score: number;
  version: string;
  project: string;
  url: string;
}
export interface SearchDocumentHit extends SearchHitValue {
  kind?: "document";
}
export interface SearchOriginalHit extends SearchHitValue {
  kind: "web" | "slides";
}
export interface SearchKnowledgeHit extends SearchHitValue {
  kind: "knowledge";
  sources: { id: string; version: string; title: string; url: string }[];
  approvedAt: number;
  uncertaintyCount: number;
}
export type SearchHit = SearchDocumentHit | SearchOriginalHit | SearchKnowledgeHit;
export type SearchAuditStatus =
  | "healthy"
  | "partial"
  | "missing"
  | "corrupt"
  | "unverified"
  | "outdated"
  | "unavailable"
  | "forbidden"
  | "superseded";
export interface SearchAuditOutcome {
  status: SearchAuditStatus;
  checks: string[];
  count: number;
  action: "none" | "rebuild";
}
export interface SearchAuditReport extends SearchAuditOutcome {
  generation: string;
  checkedAt: number;
  repairQueued: boolean;
}
export interface SearchAuditView {
  current: boolean;
  running: boolean;
  queued: boolean;
  nextAt: number;
  latest: SearchAuditReport | null;
}
export const SEARCH_LIMITS = Object.freeze({
  documents: 10000,
  textBytes: 32 * 1024 * 1024,
  documentBytes: 2 * 1024 * 1024,
  indexBytes: 128 * 1024 * 1024,
  query: 300,
  page: 20,
  candidates: 1000,
  analyzerBytes: 256 * 1024,
  analyzers: 64,
  vectorChunks: 256,
  chunkCharacters: 1600,
});
export class SearchError extends Error {
  constructor(
    readonly code:
      | "invalidInput"
      | "unavailable"
      | "conflict"
      | "notFound"
      | "limit"
      | "configuration"
      | "indexChanged"
      | "forbidden"
      | "notReady",
    readonly status = 400,
  ) {
    super(code);
  }
}
