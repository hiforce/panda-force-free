import {
  generationSourceIds,
  generationOriginalSelection,
  type KnowledgeGenerationOriginals,
} from "./generation-originals.js";
import { knowledgeObject, knowledgeText } from "./primitives.js";
import { KnowledgeError } from "./contracts.js";
import type { KnowledgeGenerationBudgetStatus } from "./generation-budget.js";

export interface KnowledgeGenerationSelection {
  all: boolean;
  documents: string[];
  subtrees: string[];
  excludeDocuments: string[];
  excludeSubtrees: string[];
  originals?: KnowledgeGenerationOriginals;
}
export interface KnowledgeGenerationPolicy {
  enabled: boolean;
  revision: number;
  purpose: string;
  selection: KnowledgeGenerationSelection;
  dailyLimit: number;
  pendingLimit: number;
}
export interface KnowledgeGenerationChange extends KnowledgeGenerationPolicy {
  backfill: boolean;
}
export interface KnowledgeGenerationSourcePage {
  commit: string;
  total: number;
  next: number | null;
  documents: {
    id: string;
    title: string;
    breadcrumb: string;
    space: string;
    parentId: string | null;
    spaceId: string;
    version: string;
  }[];
}
export interface KnowledgeGenerationStatus {
  budget: KnowledgeGenerationBudgetStatus;
  enabled: boolean;
  policyRevision: number;
  dailyUsed: number;
  counts: Record<"observed" | "queued" | "claimed" | "admitted" | "failed" | "excluded", number>;
  pendingTasks: number;
  sourceUnavailable: boolean;
}
export const GENERATION_LIMITS = Object.freeze({ selection: 256, daily: 100, pending: 16, documents: 10000 });

/** Generation permission is independent of retrieval selection and automatic knowledge review. */
export function defaultGenerationPolicy(): KnowledgeGenerationPolicy {
  return {
    enabled: false,
    revision: 0,
    purpose: "",
    selection: { all: false, documents: [], subtrees: [], excludeDocuments: [], excludeSubtrees: [] },
    dailyLimit: 8,
    pendingLimit: 4,
  };
}
export function generationChange(value: unknown): KnowledgeGenerationChange {
  const p = knowledgeObject(value, [
      "enabled",
      "revision",
      "purpose",
      "selection",
      "dailyLimit",
      "pendingLimit",
      "backfill",
    ]),
    s = knowledgeObject(p.selection, [
      "all",
      "documents",
      "subtrees",
      "excludeDocuments",
      "excludeSubtrees",
      "originals",
    ]);
  const ids = (value: unknown) => generationSourceIds(value, GENERATION_LIMITS.selection);
  if (
    typeof p.enabled !== "boolean" ||
    typeof p.backfill !== "boolean" ||
    typeof s.all !== "boolean" ||
    !Number.isSafeInteger(p.revision) ||
    Number(p.revision) < 0 ||
    !Number.isSafeInteger(p.dailyLimit) ||
    Number(p.dailyLimit) < 1 ||
    Number(p.dailyLimit) > GENERATION_LIMITS.daily ||
    !Number.isSafeInteger(p.pendingLimit) ||
    Number(p.pendingLimit) < 1 ||
    Number(p.pendingLimit) > GENERATION_LIMITS.pending
  )
    throw new KnowledgeError("invalidInput");
  const selection = {
      all: s.all,
      documents: ids(s.documents),
      subtrees: ids(s.subtrees),
      excludeDocuments: ids(s.excludeDocuments),
      excludeSubtrees: ids(s.excludeSubtrees),
      ...(s.originals === undefined
        ? {}
        : { originals: generationOriginalSelection(s.originals, GENERATION_LIMITS.selection) }),
    },
    purpose = knowledgeText(p.purpose, 4096, !p.enabled);
  if (
    p.enabled &&
    !selection.all &&
    !selection.documents.length &&
    !selection.subtrees.length &&
    !selection.originals?.all &&
    !selection.originals?.ids.length
  )
    throw new KnowledgeError("invalidInput");
  return {
    enabled: p.enabled,
    revision: Number(p.revision),
    purpose,
    selection,
    dailyLimit: Number(p.dailyLimit),
    pendingLimit: Number(p.pendingLimit),
    backfill: p.backfill,
  };
}
