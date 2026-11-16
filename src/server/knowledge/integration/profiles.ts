import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import { knowledgeId, knowledgeObject, knowledgeText } from "../../../shared/knowledge/task-validation.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import {
  DEFAULT_GENERATION_BUDGET,
  generationBudgetLimits,
  type KnowledgeGenerationBudgetLimits,
} from "../../../shared/knowledge/generation-budget.js";

export interface KnowledgeProfileSettings {
  enabled: boolean;
  id: string;
  engineId: string;
  model?: string;
  activeTimeoutMs: number;
  concurrency: number;
  generationBudget: KnowledgeGenerationBudgetLimits;
}
export function disabledKnowledgeProfile(): KnowledgeProfileSettings {
  return {
    enabled: false,
    id: "codex",
    engineId: "codex",
    activeTimeoutMs: KNOWLEDGE_LIMITS.activeTimeoutMs,
    concurrency: 1,
    generationBudget: { ...DEFAULT_GENERATION_BUDGET },
  };
}

/** Only administrator-owned configuration selects the engine and budgets. A task never supplies an endpoint or model. */
export function knowledgeProfileSettings(root: string, env: NodeJS.ProcessEnv = process.env): KnowledgeProfileSettings {
  const defaults = { ...disabledKnowledgeProfile(), enabled: true };
  if (env.PANDA_FORCE_KNOWLEDGE_ENABLED !== undefined && !["true", "false"].includes(env.PANDA_FORCE_KNOWLEDGE_ENABLED))
    throw new KnowledgeTaskError("unavailable");
  if (env.PANDA_FORCE_KNOWLEDGE_ENABLED === "false") return { ...defaults, enabled: false };
  const path = env.PANDA_FORCE_KNOWLEDGE_CONFIG_FILE || join(root, "config", "knowledge-engines.json");
  if (!existsSync(path)) {
    if (env.PANDA_FORCE_KNOWLEDGE_CONFIG_FILE) throw new KnowledgeTaskError("unavailable");
    return defaults;
  }
  const info = statSync(path);
  if (!info.isFile() || info.size > 32768) throw new KnowledgeTaskError("unavailable");
  const bytes = readFileSync(path);
  if (bytes.length > 32768) throw new KnowledgeTaskError("unavailable");
  const p = knowledgeObject(JSON.parse(bytes.toString("utf8")), [
      "schema",
      "enabled",
      "id",
      "engineId",
      "model",
      "activeTimeoutMs",
      "concurrency",
      "generationBudget",
    ]),
    activeTimeoutMs = p.activeTimeoutMs ?? defaults.activeTimeoutMs,
    concurrency = p.concurrency ?? defaults.concurrency;
  if (
    p.schema !== 1 ||
    typeof p.enabled !== "boolean" ||
    !Number.isSafeInteger(activeTimeoutMs) ||
    Number(activeTimeoutMs) < 1000 ||
    Number(activeTimeoutMs) > 600000 ||
    !Number.isSafeInteger(concurrency) ||
    Number(concurrency) < 1 ||
    Number(concurrency) > 2
  )
    throw new KnowledgeTaskError("unavailable");
  return {
    enabled: p.enabled,
    id: knowledgeId(p.id),
    engineId: knowledgeId(p.engineId),
    ...(p.model === undefined ? {} : { model: knowledgeText(p.model, 128) }),
    activeTimeoutMs: Number(activeTimeoutMs),
    concurrency: Number(concurrency),
    generationBudget:
      p.generationBudget === undefined ? { ...DEFAULT_GENERATION_BUDGET } : generationBudgetLimits(p.generationBudget),
  };
}
