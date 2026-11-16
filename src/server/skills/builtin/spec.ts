import type { SkillDefinition } from "../../../shared/skills/contracts.js";

export interface BuiltinSkillSpec {
  id: string;
  category: SkillDefinition["category"];
  name: { en: string; "zh-CN": string };
  description: { en: string; "zh-CN": string };
  inputs: string;
  steps: readonly string[];
  sections: readonly string[];
  checks: readonly string[];
  example: { en: string; "zh-CN": string };
}
