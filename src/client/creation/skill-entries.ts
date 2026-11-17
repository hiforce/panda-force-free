import type { InstalledSkillPack } from "../../shared/skills/registry.js";
import type { SkillCapability } from "../../shared/skills/contracts.js";
import { skillDisplayDefinition, skillDisplayPackName } from "../../shared/presentation/skill-display.js";
import { internalExecutionSkill } from "../../shared/skills/presentation.js";
import { availableInstalledSkill } from "../../shared/skills/availability.js";
import type { CreationSkillEntry } from "./skill-views.js";

/** Discovery, the picker and selected cards share the same installed version and availability policy. */
export function creationSkillEntries(
  pack: InstalledSkillPack,
  capabilities: readonly SkillCapability[],
  allOutputs = false,
): CreationSkillEntry[] {
  return pack.manifest.skills
    .map((original) => {
      const definition = skillDisplayDefinition(pack, original);
      return {
        reference: {
          packageId: pack.id,
          version: pack.version,
          digest: pack.digest,
          id: definition.id,
          parameters: {},
        },
        definition,
        name: skillDisplayPackName(pack),
        origin: pack.origin,
        publisher: pack.manifest.publisher.name,
        license: pack.manifest.license.expression,
        visible: !internalExecutionSkill(pack, definition),
        enabled:
          availableInstalledSkill(pack, definition) &&
          definition.outputTypes.includes("document") &&
          definition.composition.appliesTo.includes("document") &&
          definition.capabilities.every((value) => capabilities.includes(value)),
      };
    })
    .filter(
      (entry) =>
        allOutputs ||
        (entry.definition.outputTypes.includes("document") &&
          entry.definition.composition.appliesTo.includes("document")),
    );
}
