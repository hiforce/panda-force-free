import { SEARCH_LIMITS, SearchError, type SearchDocument } from "../../../shared/search/contracts.js";
import type { SearchAnalyzer } from "../ports.js";

/** External text backends consume the same bounded recipe, evaluated by the existing index worker. */
export function projectSearchText(document: SearchDocument, analyzer: SearchAnalyzer) {
  if (Buffer.byteLength(document.text) > SEARCH_LIMITS.documentBytes) throw new SearchError("limit", 409);
  const value = {
    title: analyzer.tokens(document.title).join(" "),
    text: analyzer.tokens(document.text).join(" "),
    version: document.version,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new SearchError("limit", 409);
  return value;
}
