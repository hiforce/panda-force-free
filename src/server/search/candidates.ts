import type { MetadataStore } from "../knowledge/metadata-ports.js";
import { SEARCH_LIMITS, SearchError, type SearchMode, type SearchScope } from "../../shared/search/contracts.js";
import type { SearchCandidate, ApprovedKnowledgeSource } from "./ports.js";
import type { ActiveSearchIndex } from "./state.js";
import type { SearchRuntime } from "./indexer.js";
import type { SearchAnalyzer } from "./ports.js";
export interface RankedSearchCandidate extends SearchCandidate {
  kind: "document" | "knowledge";
}
export function fuseSearchCandidates(lists: readonly (readonly RankedSearchCandidate[])[]): RankedSearchCandidate[] {
  const values = new Map<string, RankedSearchCandidate>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((hit, index) => {
      const key = hit.kind + ":" + hit.id;
      if (seen.has(key)) return;
      seen.add(key);
      const score = 1 / (60 + index + 1),
        prior = values.get(key);
      if (prior) prior.score += score;
      else values.set(key, { ...hit, score });
    });
  }
  return [...values.values()].sort(
    (a, b) => b.score - a.score || (a.kind + ":" + a.id).localeCompare(b.kind + ":" + b.id),
  );
}
export async function querySearchCandidates(options: {
  scope: SearchScope;
  active: ActiveSearchIndex;
  runtime: MetadataStore<SearchRuntime>;
  analyzer: SearchAnalyzer;
  query: string;
  mode: SearchMode;
  fulltext: boolean;
  vector: boolean;
  knowledge?: ApprovedKnowledgeSource;
  signal: AbortSignal;
}) {
  const { active, runtime, analyzer, query, mode, signal } = options;
  let text: RankedSearchCandidate[] = [],
    semantic: RankedSearchCandidate[] = [];
  if (mode !== "semantic" && active.text && options.fulltext)
    text = (
      await (await runtime.text(active.source)).query(active.text, query, analyzer, SEARCH_LIMITS.candidates, signal)
    ).map((hit) => ({ ...hit, kind: "document" }));
  if (mode !== "text") {
    const vectors = await runtime.vectors(active.source, options.scope);
    if (!options.vector || !vectors || !active.vector || !options.knowledge)
      throw new SearchError("configuration", 409);
    semantic = (await vectors.query(active.vector, query, SEARCH_LIMITS.candidates, signal)).map((hit) => ({
      ...hit,
      kind: "knowledge",
    }));
  }
  return mode === "hybrid"
    ? fuseSearchCandidates([text, semantic]).slice(0, SEARCH_LIMITS.candidates)
    : mode === "semantic"
      ? semantic
      : text;
}
