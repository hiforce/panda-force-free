import type { SkillDefinition } from "./contracts.js";
import type { InstalledSkillPack } from "./registry.js";

/** Only trusted application scaffolds are internal; customer workflows remain discoverable. */
export function internalExecutionSkill(
  pack: Pick<InstalledSkillPack, "id" | "origin">,
  skill: Pick<SkillDefinition, "id" | "role">,
): boolean {
  return (
    pack.origin.kind === "builtin" &&
    pack.origin.id === pack.id &&
    ["panda-force.document-creation", "panda-force.writing"].includes(pack.id) &&
    skill.id === "writing" &&
    skill.role === "workflow"
  );
}
export function skillPresentationType(skill: Pick<SkillDefinition, "role" | "outputTypes">): string {
  if (skill.role === "workflow") return "panda.creation-workflow";
  if (skill.role === "style") return "panda.creation-style";
  if (skill.outputTypes.length === 1 && skill.outputTypes[0] === "document") return "panda.document-template";
  if (skill.outputTypes.length === 1 && skill.outputTypes[0] === "slides") return "panda.slides-template";
  return "panda.creation-template";
}
