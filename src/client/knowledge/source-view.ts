import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeSourceChoice } from "./source-types.js";
import { escapeHtml as e } from "../../shared/html.js";

export const sourceKindMessage = {
  document: "knowledge.sourceDocuments",
  web: "creative.web",
  slides: "creative.slides",
} as const;
export function knowledgeSourcesHtml(
  sources: readonly (Pick<KnowledgeSourceChoice, "id" | "title"> & Partial<Pick<KnowledgeSourceChoice, "kind">>)[],
  selected: ReadonlySet<string>,
  t?: Translate,
) {
  return sources
    .map(
      (source) =>
        `<label class="wb-choice"><input type="checkbox" name="pf-knowledge-source" value="${e(source.id)}" ${selected.has(source.id) ? "checked" : ""}><span><span data-i18n-ignore>${e(source.title)}</span>${t && source.kind ? ` <small>${e(t(sourceKindMessage[source.kind]))}</small>` : ""}</span></label>`,
    )
    .join("");
}
