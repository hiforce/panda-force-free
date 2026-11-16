import type { SavedSourceKind } from "../content-sources/contracts.js";
import { knowledgeId, knowledgeObject } from "./primitives.js";
import { KnowledgeError } from "./contracts.js";

export type GenerationOriginalKind = Exclude<SavedSourceKind, "document">;
export interface KnowledgeGenerationOriginals {
  contentKinds: GenerationOriginalKind[];
  all: boolean;
  ids: string[];
  exclude: string[];
}
export function generationSourceIds(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new KnowledgeError("invalidInput");
  const result = value.map(knowledgeId).sort();
  if (new Set(result).size !== result.length) throw new KnowledgeError("invalidInput");
  return result;
}
/** Native scope is affirmative and flat; a document subtree never selects an original implicitly. */
export function generationOriginalSelection(value: unknown, limit: number): KnowledgeGenerationOriginals {
  const p = knowledgeObject(value, ["contentKinds", "all", "ids", "exclude"]),
    kinds = ["slides", "web"] as const;
  if (
    typeof p.all !== "boolean" ||
    !Array.isArray(p.contentKinds) ||
    !p.contentKinds.length ||
    p.contentKinds.length > 2 ||
    new Set(p.contentKinds).size !== p.contentKinds.length ||
    p.contentKinds.some((kind) => !kinds.includes(kind))
  )
    throw new KnowledgeError("invalidInput");
  return {
    contentKinds: kinds.filter((kind) => (p.contentKinds as unknown[]).includes(kind)),
    all: p.all,
    ids: generationSourceIds(p.ids, limit),
    exclude: generationSourceIds(p.exclude, limit),
  };
}
