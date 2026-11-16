import { KnowledgeError } from "./contracts.js";
import { knowledgeObject } from "./primitives.js";

export interface KnowledgeGenerationBudgetLimits {
  installationDaily: number;
  ownerDaily: number;
  installationPending: number;
  ownerPending: number;
}
export const DEFAULT_GENERATION_BUDGET: Readonly<KnowledgeGenerationBudgetLimits> = Object.freeze({
  installationDaily: 128,
  ownerDaily: 32,
  installationPending: 32,
  ownerPending: 8,
});
/** Administrator configuration bounds all projects together; rule input cannot replace these limits. */
export function generationBudgetLimits(input: unknown): KnowledgeGenerationBudgetLimits {
  const keys = ["installationDaily", "ownerDaily", "installationPending", "ownerPending"] as const,
    value = knowledgeObject(input, keys),
    result = { ...DEFAULT_GENERATION_BUDGET };
  for (const key of keys) {
    const fallback =
      key === "ownerDaily"
        ? Math.min(result.ownerDaily, result.installationDaily)
        : key === "ownerPending"
          ? Math.min(result.ownerPending, result.installationPending)
          : result[key];
    const limit = value[key] === undefined ? fallback : value[key];
    if (!Number.isSafeInteger(limit) || Number(limit) < 0 || Number(limit) > 100000)
      throw new KnowledgeError("invalidInput");
    result[key] = Number(limit);
  }
  if (result.ownerDaily > result.installationDaily || result.ownerPending > result.installationPending)
    throw new KnowledgeError("invalidInput");
  return result;
}
export type GenerationBudgetBlock =
  "projectDaily" | "projectPending" | "ownerDaily" | "ownerPending" | "installationDaily" | "installationPending";
export interface KnowledgeGenerationBudgetStatus {
  limits: KnowledgeGenerationBudgetLimits;
  ownerDailyUsed: number;
  ownerPending: number;
  blocked: GenerationBudgetBlock | null;
}
