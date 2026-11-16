import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { SearchResults } from "./api.js";
export function searchResultsHtml(value: SearchResults, t: Translate) {
  return (
    value.hits
      .map(
        (hit) =>
          `<a class="content-search-hit" href="${e(hit.url)}" data-wb="route" data-route="${e(hit.url)}"><strong data-i18n-ignore>${e(hit.title)}</strong>${hit.kind === "knowledge" ? `<small>${e(t("knowledge.resultKind", { count: hit.sources.length }))}</small>` : hit.kind === "web" || hit.kind === "slides" ? `<small>${e(t(`creative.${hit.kind}`))}</small>` : ""}<span data-i18n-ignore>${e(hit.snippet)}</span></a>`,
      )
      .join("") ||
    `<p>${e(t(value.state === "needsReview" ? "search.projectReviewPending" : value.state === "ready" ? "search.noMatches" : value.state === "failed" ? "search.indexFailed" : value.state === "disabled" ? "search.indexDisabled" : "search.indexPreparing"))}</p>`
  );
}
export function searchStateLabel(state: string, t: Translate) {
  const labels = {
    ready: "search.ready",
    queued: "search.queued",
    running: "search.indexing",
    failed: "search.indexFailed",
    disabled: "search.indexDisabled",
    needsReview: "search.projectReviewPending",
  } as const;
  return t(labels[state as keyof typeof labels] ?? "search.indexPreparing");
}
