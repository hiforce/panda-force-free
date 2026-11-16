import type { KnowledgeEvidenceSource } from "../../../shared/knowledge/contracts.js";
import type { SavedSourceText } from "../../../shared/content-sources/contracts.js";
import type { KnowledgeCatalogEntry, KnowledgeCatalogProjection } from "../catalog/contracts.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import type { OwnedProjectDirectory } from "../../project-content/owned-directory.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { stableJson } from "../../../shared/stable-json.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { savedKnowledgeDocuments } from "./saved-documents.js";

type SourceBinding = KnowledgeCatalogProjection["sources"][number];
export interface ApprovedKnowledgeSources {
  matches(binding: SourceBinding): boolean;
  ancestors(id: string): string[];
  read(binding: SourceBinding): Promise<{
    source: KnowledgeEvidenceSource;
    title: string;
    path: string;
    ancestors: string[];
  }>;
}

export function nativeKnowledgeSelection(entries: readonly KnowledgeCatalogEntry[]) {
  const bindings = entries.flatMap((entry) => entry.projection.sources).filter((source) => source.binding);
  return {
    ids: [...new Set(bindings.map((source) => source.id))],
    kinds: [...new Set(bindings.map((source) => source.binding!.kind))],
  };
}

/** Metadata gates remain cheap; prepared native text is admitted only after a final raw-file and resource check. */
export async function approvedKnowledgeSources(
  view: ProjectContentView,
  owned: OwnedProjectDirectory,
  project: string,
  entries: readonly KnowledgeCatalogEntry[],
  originals?: FileOriginalQueries,
  prepared?: ReadonlyMap<string, SavedSourceText>,
): Promise<ApprovedKnowledgeSources> {
  const bindings = entries.flatMap((entry) => entry.projection.sources),
    documentIds = new Set(bindings.filter((source) => !source.binding).map((source) => source.id)),
    documents = documentIds.size ? await savedKnowledgeDocuments(view, project, documentIds) : null,
    selected = nativeKnowledgeSelection(entries);
  if (selected.ids.length && !originals) throw new KnowledgeTaskError("unavailable");
  const native = selected.ids.length
      ? await originals!.saved(view, owned, project, selected.kinds, new Set(selected.ids))
      : null,
    metadata = new Map(native?.entries.map((row) => [row.id, row])),
    verified = new Set<string>();
  const matches = (binding: SourceBinding) => {
    if (!binding.binding) return documents?.documents.get(binding.id)?.version === binding.blob;
    const row = metadata.get(binding.id);
    return (
      row?.version === binding.version &&
      row.binding.blob === binding.blob &&
      stableJson(row.binding) === stableJson(binding.binding)
    );
  };
  return {
    matches,
    ancestors: (id) => metadata.get(id)?.ancestors.slice() ?? documents?.ancestors(id) ?? [],
    async read(binding) {
      if (!matches(binding)) throw new KnowledgeTaskError("conflict");
      if (!binding.binding) {
        const saved = await documents!.read(binding.id);
        return {
          source: saved.source,
          title: saved.detail.document.title,
          path: saved.detail.document.path,
          ancestors: documents!.ancestors(binding.id),
        };
      }
      const row = metadata.get(binding.id)!,
        value = prepared?.get(binding.id);
      if (!value || stableJson(value.metadata) !== stableJson(row)) throw new KnowledgeTaskError("conflict");
      if (!verified.has(binding.id)) {
        await native!.verify(binding.id);
        verified.add(binding.id);
      }
      view.assertHeld();
      return {
        source: {
          id: row.id,
          version: row.version,
          kind: "asset",
          binding: structuredClone(row.binding),
          title: row.title,
          text: value.text,
          sections: structuredClone(value.sections),
        },
        title: row.title,
        path: row.path,
        ancestors: [...row.ancestors],
      };
    },
  };
}
