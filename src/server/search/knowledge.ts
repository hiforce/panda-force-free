import { createHash } from "node:crypto";
import type { ApprovedKnowledgeValue } from "../../shared/knowledge/catalog.js";
import type { KnowledgeRecord } from "../../shared/knowledge/tasks.js";
import type { SearchSettings } from "../../shared/search/contracts.js";
import type { SearchVectorDocument } from "./ports.js";
import { pathSelected, knowledgeSelected } from "./snippets.js";
import { searchContentKinds } from "../../shared/search/validation.js";

/** Every original must remain eligible; selecting one source never exposes a record built from unselected context. */
export function knowledgeEligible(value: ApprovedKnowledgeValue, settings: SearchSettings) {
  const assets = value.record.sources.filter((source) => source.kind === "asset"),
    kinds = new Set(searchContentKinds(settings.contentKinds));
  return (
    value.sources.length > 0 &&
    assets.length === value.sources.length &&
    value.sources.every(
      (source) =>
        kinds.has(source.binding?.kind ?? "document") &&
        assets.some((asset) => asset.id === source.id && asset.version === source.version) &&
        pathSelected(source.path, settings.include, settings.exclude) &&
        knowledgeSelected(source, settings.knowledge),
    )
  );
}
export function knowledgeSearchText(record: KnowledgeRecord) {
  return [
    record.draft.summary,
    ...record.draft.claims.map((claim) => claim.kind + ": " + claim.text),
    ...record.draft.uncertainties.map((value) => "open question: " + value),
  ].join("\n");
}
export function knowledgeVectorDocument(value: ApprovedKnowledgeValue): SearchVectorDocument {
  const { record } = value;
  return { id: record.id, version: record.version, title: record.draft.title, text: knowledgeSearchText(record) };
}

/** Source heads may change without changing the selected approved payload. */
export function knowledgeVectorInput(documents: SearchVectorDocument[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...documents]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((d) => [d.id, d.version, d.title, d.text]),
      ),
    )
    .digest("hex");
}
