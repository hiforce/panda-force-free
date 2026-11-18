import type {
  VerifiedSkillPack,
  SkillCapability,
  SkillConstraints,
  SkillDefinition,
  SkillOutput,
  ImmutableSkillData,
} from "./contracts.js";
import { SKILL_LIMITS } from "./contracts.js";
import { skillAssert } from "./errors.js";
import { assertSkillCompatibility } from "./manifest.js";
import { skillParameterValues, type SkillParameterValues } from "./parameters.js";
import { freezeSkillValue } from "./resources.js";
export interface SelectedSkill {
  pack: VerifiedSkillPack;
  id: string;
  parameters: unknown;
}
export interface FrozenSkillSelection {
  packageId: string;
  version: string;
  digest: string;
  id: string;
  qualifiedId: string;
  role: SkillDefinition["role"];
  instructions: string;
  template?: string;
  parameters: SkillParameterValues;
}
export interface SkillComposition {
  schema: 1;
  mode?: "guidance";
  outputType: SkillOutput;
  skills: readonly FrozenSkillSelection[];
  capabilities: readonly SkillCapability[];
  constraints: SkillConstraints;
}
export interface SkillCompositionAuthority {
  applicationVersion: string;
  outputType: SkillOutput;
  available: ReadonlySet<SkillCapability>;
  granted: ReadonlySet<SkillCapability>;
  entitled: ReadonlySet<string>;
  /** Free conversations can use style or template guidance without a document workflow. */
  workflowRequired?: boolean;
  /** Application-owned guidance preserves package instructions without delegating final artifact choice. */
  guidanceOnly?: boolean;
}
/** Selection order is preserved. Instructions and parameters remain separate data, never authority. */
export function composeSkills(
  selections: readonly SelectedSkill[],
  authority: SkillCompositionAuthority,
): ImmutableSkillData<SkillComposition> {
  skillAssert(selections.length <= SKILL_LIMITS.selections, "packageTooLarge", "skills");
  const definitions = selections.map((selection) => {
    assertSkillCompatibility(selection.pack.manifest, authority.applicationVersion);
    const skill = selection.pack.manifest.skills.find((item) => item.id === selection.id);
    skillAssert(skill, "invalidIdentity", "skill");
    return { selection, skill, qualifiedId: selection.pack.manifest.id + "/" + skill.id };
  });
  skillAssert(new Set(definitions.map((item) => item.qualifiedId)).size === definitions.length, "duplicateSkill");
  const workflows = definitions.filter((item) => item.skill.role === "workflow").length;
  skillAssert(
    authority.guidanceOnly || authority.workflowRequired === false ? workflows <= 1 : workflows === 1,
    "workflowRequired",
  );
  const selected = new Set(definitions.map((item) => item.qualifiedId)),
    capabilities = new Set<SkillCapability>(),
    merged: Record<string, string> = {};
  let instructionBytes = 0;
  const skills: FrozenSkillSelection[] = definitions.map(({ selection, skill, qualifiedId }) => {
    const { pack } = selection;
    skillAssert(
      authority.guidanceOnly === true ||
        (skill.outputTypes.includes(authority.outputType) &&
          skill.composition.appliesTo.includes(authority.outputType)),
      "incompatibleOutput",
      qualifiedId,
    );
    skillAssert(!skill.composition.conflictsWith.some((id) => selected.has(id)), "conflictingSkills", qualifiedId);
    skillAssert(
      !skill.entitlement || authority.entitled.has(pack.digest + "/" + skill.id),
      "entitlementRequired",
      qualifiedId,
    );
    for (const capability of skill.capabilities) {
      skillAssert(
        authority.granted.has(capability) && authority.available.has(capability),
        "capabilityUnavailable",
        capability,
      );
      capabilities.add(capability);
    }
    for (const [key, value] of Object.entries(skill.composition.constraints)) {
      skillAssert(merged[key] === undefined || merged[key] === value, "conflictingConstraints", key);
      merged[key] = value;
    }
    const instructions = pack.text(skill.instructions),
      template = skill.template ? pack.text(skill.template) : undefined;
    instructionBytes +=
      new TextEncoder().encode(instructions).length +
      (template === undefined ? 0 : new TextEncoder().encode(template).length);
    skillAssert(instructionBytes <= SKILL_LIMITS.taskInstructionBytes, "packageTooLarge", "instructions");
    return {
      packageId: pack.manifest.id,
      version: pack.manifest.version,
      digest: pack.digest,
      id: skill.id,
      qualifiedId,
      role: skill.role,
      instructions,
      ...(template === undefined ? {} : { template }),
      parameters: skillParameterValues(skill, selection.parameters),
    };
  });
  return freezeSkillValue({
    schema: 1,
    ...(authority.guidanceOnly ? { mode: "guidance" as const } : {}),
    outputType: authority.outputType,
    skills,
    capabilities: [...capabilities],
    constraints: merged as SkillConstraints,
  });
}
