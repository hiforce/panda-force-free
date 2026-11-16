import { request } from "../http-client.js";
import { readContentAccess } from "../content-access/api.js";
import type {
  AnalyzerPackage,
  SearchHit,
  SearchSettings,
  SearchSourceDefinition,
  SearchAuditView,
  SearchEmbeddingUsage,
  ProjectSearchPolicySummary,
  SearchBuildProgress,
} from "../../shared/search/contracts.js";
export interface SearchCatalog {
  administrator: boolean;
  binding: { source: string; revision: number };
  sources: SearchSourceDefinition[];
  connections: {
    id: string;
    kind: "elasticsearch" | "milvus" | "ollama" | "openai";
    url: string;
    managed: boolean;
    model?: string;
    dimensions?: number;
  }[];
  knowledge: { id: string; vectors: string; embeddings: string }[];
  analyzers: { reference: string; descriptor: AnalyzerPackage }[];
}
export interface SearchStatus {
  projectPolicy?: ProjectSearchPolicySummary | null;
  embedding?: SearchEmbeddingUsage;
  settings: SearchSettings;
  revision: number;
  state: string;
  documentCount: number;
  failure: string | null;
  ready: boolean;
  source: string;
  updatedAt?: number;
  progress?: SearchBuildProgress | null;
  audit?: SearchAuditView;
}
export interface SearchResults {
  hits: SearchHit[];
  nextCursor: string | null;
  state: string;
  failure: string | null;
}
export interface AnalyzerReview {
  digest: string;
  packages: AnalyzerPackage[];
  origin: Record<string, unknown>;
}
export class SearchRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export async function searchRequest<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request("/api/search" + path, {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new SearchRequestError(typeof result.code === "string" ? result.code : "unavailable");
  return result as T;
}
export async function searchProjects(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  return (await readContentAccess(signal)).projects;
}
