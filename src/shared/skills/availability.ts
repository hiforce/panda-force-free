import type { SkillDefinition } from "./contracts.js";
import type { InstalledSkillPack } from "./registry.js";

/** Use surfaces share this gate; management and version inspection keep the full installed records. */
export function availableInstalledSkill(pack: InstalledSkillPack, skill: SkillDefinition): boolean {
  return (
    !pack.removed &&
    pack.active &&
    pack.exports.some((entry) => entry.id === skill.id && entry.enabled) &&
    !skill.entitlement &&
    skill.capabilities.every((capability) => pack.grants.includes(capability))
  );
}
