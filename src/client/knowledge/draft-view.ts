import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeDraft } from "../../shared/knowledge/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";

/** Draft review and approved reading share the same escaped claims, distinctions and source evidence. */
export function knowledgeDraftHtml(
  draft: KnowledgeDraft,
  t: Translate,
  options: { title?: boolean; sources?: readonly { id: string; title: string }[]; compactEvidence?: boolean } = {},
) {
  const { title = true, sources = [], compactEvidence = false } = options;
  return `${title ? `<h3 data-i18n-ignore>${e(draft.title)}</h3>` : ""}<p data-i18n-ignore>${e(draft.summary)}</p>${draft.claims.map((claim) => `<article class="knowledge-claim"><span class="resource-badge">${e(t(({ source: "knowledge.claimSource", inference: "knowledge.claimInference", user: "knowledge.claimUser" } as const)[claim.kind]))}</span><p data-i18n-ignore>${e(claim.text)}</p><details><summary>${e(t("knowledge.evidence"))} · ${claim.evidence.length}</summary>${claim.evidence.map((quote) => `<blockquote data-i18n-ignore>${e(quote.quote)}</blockquote><small data-i18n-ignore>${e(sources.find((source) => source.id === quote.sourceId)?.title || quote.sourceId)}${compactEvidence ? "" : ` · ${e(quote.version)} · ${quote.start}–${quote.end}`}</small>`).join("")}</details></article>`).join("")}${draft.uncertainties.length ? `<h4>${e(t("knowledge.openQuestions"))}</h4><ul>${draft.uncertainties.map((text) => `<li data-i18n-ignore>${e(text)}</li>`).join("")}</ul>` : ""}`;
}
