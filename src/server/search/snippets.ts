import type { SearchAnalyzer } from "./ports.js";
import type { SearchDocument, KnowledgeRules } from "../../shared/search/contracts.js";
/** Text-only excerpts are escaped by presentation; no provider HTML is trusted. */
export function searchSnippet(text: string, query: string, analyzer: SearchAnalyzer) {
  const terms = analyzer.tokens(query).filter((x) => !x.startsWith("=")),
    folded = text.toLocaleLowerCase(analyzer.descriptor.locale);
  let at = -1;
  for (const term of terms) {
    const found = folded.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 80);
  return (
    (start ? "…" : "") + text.slice(start, start + 320).replace(/\s+/g, " ") + (text.length > start + 320 ? "…" : "")
  );
}
export function pathSelected(path: string, include: string[], exclude: string[]) {
  const match = (rule: string) => path === rule || path.startsWith(rule.endsWith("/") ? rule : rule + "/");
  return !exclude.some(match) && (!include.length || include.some(match));
}
/** Logical document ancestry, rather than source filenames, determines inherited knowledge rules. Exclusions win. */
export function knowledgeReason(
  document: Pick<SearchDocument, "id" | "ancestors">,
  rules: KnowledgeRules,
): "excluded" | "manual" | "subtree" | "project" | "none" {
  const family = [document.id, ...document.ancestors];
  if (rules.exclude.some((id) => family.includes(id))) return "excluded";
  if (rules.documents.includes(document.id)) return "manual";
  if (rules.mode === "project") return "project";
  if (rules.mode === "selected" && rules.subtrees.some((id) => family.includes(id))) return "subtree";
  return "none";
}
export const knowledgeSelected = (document: Pick<SearchDocument, "id" | "ancestors">, rules: KnowledgeRules) =>
  !["none", "excluded"].includes(knowledgeReason(document, rules));
