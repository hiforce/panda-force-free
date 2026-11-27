import type {
  AnalyzerPackage,
  SearchDocument,
  SearchScope,
  SearchSnapshot,
  SearchReadScope,
  SearchSourceDefinition,
} from "../../shared/search/contracts.js";
import type { ApprovedKnowledgeReader } from "../knowledge/catalog/contracts.js";
import type { IndexBuildProgress } from "./progress.js";
export interface SearchSource {
  authorize(scope: SearchScope): Promise<void>;
  head(scope: SearchReadScope): Promise<string>;
  snapshot(scope: SearchReadScope, signal?: AbortSignal): Promise<SearchSnapshot>;
  current(scope: SearchReadScope, ids: string[], signal?: AbortSignal): Promise<SearchDocument[]>;
  metadata?(scope: SearchReadScope): Promise<{ commit: string; documents: Omit<SearchDocument, "text">[] }>;
}
/** Only approved, source-bound knowledge may be embedded. Raw document selection is not knowledge production. */
export type ApprovedKnowledgeSource = ApprovedKnowledgeReader;
export type SearchVectorDocument = Pick<SearchDocument, "id" | "title" | "version" | "text">;
export interface SearchAnalyzer {
  descriptor: AnalyzerPackage;
  digest: string;
  tokens(text: string): string[];
}
export interface IndexReference {
  name: string;
  provider: string;
  integrity?: {
    schema: 1;
    format: string;
    digest: string;
    count: number;
    recipe: string;
    pageSize?: number;
    checkpoint?: string;
  };
}
export interface IndexAuditResult {
  count: number;
  checks: string[];
}
export interface SearchTextProjector {
  project(
    document: SearchDocument,
    analyzer: SearchAnalyzer,
    signal: AbortSignal,
  ): Promise<{ title: string; text: string; version: string }>;
}
export interface SearchCandidate {
  id: string;
  version: string;
  title: string;
  snippet: string;
  score: number;
}
export interface SearchEmbeddingProvider {
  readonly dimensions: number;
  fingerprint(): string;
  embed(texts: string[], signal: AbortSignal, purpose?: "document" | "query"): Promise<number[][]>;
  health(): Promise<boolean>;
}
export interface TextIndexProvider {
  readonly id: "local" | "elasticsearch";
  build(
    name: string,
    documents: SearchDocument[],
    analyzer: SearchAnalyzer,
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ): Promise<IndexReference>;
  query(
    index: IndexReference,
    query: string,
    analyzer: SearchAnalyzer,
    limit: number,
    signal: AbortSignal,
    options?: { match?: "any" },
  ): Promise<SearchCandidate[]>;
  drop(index: IndexReference, signal?: AbortSignal): Promise<void>;
  health(): Promise<boolean>;
  fingerprint(): string;
  canRetire?(fingerprint: string): boolean;
  audit(index: IndexReference, analyzer: SearchAnalyzer, signal: AbortSignal): Promise<IndexAuditResult>;
}
export interface VectorIndexProvider {
  build(
    name: string,
    documents: SearchVectorDocument[],
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ): Promise<IndexReference>;
  query(index: IndexReference, query: string, limit: number, signal: AbortSignal): Promise<SearchCandidate[]>;
  drop(index: IndexReference): Promise<void>;
  health(): Promise<boolean>;
  /** Background maintenance may probe storage, but must never invoke model inference for connectivity. */
  storageHealth?(signal: AbortSignal): Promise<boolean>;
  fingerprint(): string;
  canRetire?(fingerprint: string): boolean;
  audit?(index: IndexReference, signal: AbortSignal): Promise<IndexAuditResult>;
}

export interface SearchRuntime {
  source(id: string): SearchSourceDefinition;
  text(source: SearchSourceDefinition): TextIndexProvider;
  vectors(source: SearchSourceDefinition, scope?: SearchScope): VectorIndexProvider | null;
  analyzer(reference: string): Promise<SearchAnalyzer>;
  generation(key: string, token: string): string;
}
