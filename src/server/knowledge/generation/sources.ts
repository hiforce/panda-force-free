import type { KnowledgeGenerationSelection } from "../../../shared/knowledge/generation.js";
import { GENERATION_LIMITS } from "../../../shared/knowledge/generation.js";
import type { GenerationSnapshot, GenerationSourceIdentity, GenerationReadScope } from "./contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { generationMatches } from "./selection.js";

/** Missing native intent retains the exact document-only source contract. */
export function generationReadScope(selection: KnowledgeGenerationSelection): GenerationReadScope | undefined {
  return selection.originals
    ? {
        documents: selection.all || !!selection.documents.length || !!selection.subtrees.length,
        originals: [...selection.originals.contentKinds],
      }
    : undefined;
}
export function generationIdentities(snapshot: GenerationSnapshot): GenerationSourceIdentity[] {
  const sources = [
    ...snapshot.documents.map(({ id, version }) => ({ id, version, kind: "document" as const })),
    ...(snapshot.originals ?? []),
  ];
  if (sources.length > GENERATION_LIMITS.documents) throw new KnowledgeTaskError("budget");
  if (new Set(sources.map((row) => row.id)).size !== sources.length) throw new KnowledgeTaskError("conflict");
  return sources;
}
/** Document ancestry and flat native selection stay separate; exclusions apply only to their declared domain. */
export function generationSelectedSnapshot(
  snapshot: GenerationSnapshot,
  selection: KnowledgeGenerationSelection,
): GenerationSnapshot {
  generationIdentities(snapshot);
  const native = selection.originals,
    ids = new Set(native?.ids),
    exclude = new Set(native?.exclude);
  return {
    commit: snapshot.commit,
    documents: generationMatches(snapshot, selection),
    ...(native
      ? {
          originals: (snapshot.originals ?? []).filter(
            (row) => native.contentKinds.includes(row.kind) && !exclude.has(row.id) && (native.all || ids.has(row.id)),
          ),
        }
      : {}),
  };
}
