import {
  SEARCH_LIMITS,
  SearchError,
  type SearchScope,
  type SearchSettings,
  type SearchHit,
} from "../../shared/search/contracts.js";
import type { SearchSource, ApprovedKnowledgeSource, SearchAnalyzer } from "./ports.js";
import type { RankedSearchCandidate } from "./candidates.js";
import { pathSelected, searchSnippet } from "./snippets.js";
import { knowledgeEligible, knowledgeSearchText } from "./knowledge.js";
import { searchReadScope } from "./content-selection.js";
import { savedSourceUrl } from "../../shared/content-sources/links.js";

/** Search candidates only select identities. Authoritative readers supply every visible word, source and URL. */
export async function hydrateSearchPage(options: {
  content: SearchSource;
  knowledge?: ApprovedKnowledgeSource;
  scope: SearchScope;
  settings: SearchSettings;
  candidates: RankedSearchCandidate[];
  offset: number;
  query: string;
  analyzer: SearchAnalyzer;
  signal: AbortSignal;
}) {
  const { content, knowledge, scope, settings, candidates, query, analyzer, signal } = options,
    hits: SearchHit[] = [];
  let scanned = options.offset,
    stale = false;
  while (hits.length < SEARCH_LIMITS.page && scanned < candidates.length) {
    signal.throwIfAborted();
    const batch = candidates.slice(scanned, scanned + SEARCH_LIMITS.page),
      documentIds = batch.filter((hit) => hit.kind === "document").map((hit) => hit.id),
      documents = new Map(
        (documentIds.length ? await content.current(searchReadScope(scope, settings), documentIds, signal) : []).map(
          (value) => [value.id, value],
        ),
      ),
      ids = batch.filter((hit) => hit.kind === "knowledge").map((hit) => hit.id);
    if (ids.length && !knowledge) throw new SearchError("configuration", 409);
    const records = new Map(
      (ids.length ? await knowledge!.current(scope, ids) : []).map((value) => [value.record.id, value]),
    );
    for (const hit of batch) {
      scanned++;
      if (hit.kind === "knowledge") {
        const value = records.get(hit.id);
        if (!value || value.record.version !== hit.version) {
          stale = true;
          continue;
        }
        if (!knowledgeEligible(value, settings)) continue;
        const { record } = value;
        hits.push({
          kind: "knowledge",
          id: record.id,
          title: record.draft.title,
          version: record.version,
          project: scope.project,
          score: hit.score,
          snippet: searchSnippet(knowledgeSearchText(record), query, analyzer),
          approvedAt: record.approvedAt,
          uncertaintyCount: record.draft.uncertainties.length,
          sources: value.sources.map((source) => ({
            id: source.id,
            version: source.version,
            title: source.title,
            url: savedSourceUrl(scope.project, source.id, source.binding?.kind, source.version),
          })),
          url: "/documents?" + new URLSearchParams({ project: scope.project, knowledge: record.id }),
        });
      } else {
        const document = documents.get(hit.id);
        if (!document || document.version !== hit.version) {
          stale = true;
          continue;
        }
        if (!pathSelected(document.path, settings.include, settings.exclude)) continue;
        hits.push({
          ...(document.kind && document.kind !== "document" ? { kind: document.kind } : {}),
          id: document.id,
          title: document.title,
          version: document.version,
          project: scope.project,
          score: hit.score,
          snippet: searchSnippet(document.text, query, analyzer),
          url: savedSourceUrl(scope.project, document.id, document.kind, document.version),
        });
      }
      if (hits.length === SEARCH_LIMITS.page) break;
    }
  }
  signal.throwIfAborted();
  return { hits, scanned, stale };
}
