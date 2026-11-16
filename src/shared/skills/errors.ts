export type SkillErrorCode =
  | "invalidManifest"
  | "invalidIdentity"
  | "invalidResourcePath"
  | "invalidResource"
  | "packageTooLarge"
  | "incompatibleVersion"
  | "missingResource"
  | "duplicateSkill"
  | "invalidParameters"
  | "incompatibleOutput"
  | "workflowRequired"
  | "conflictingSkills"
  | "conflictingConstraints"
  | "capabilityUnavailable"
  | "entitlementRequired";
export class SkillContractError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    readonly field = "",
  ) {
    super(code);
    this.name = "SkillContractError";
  }
}
export function skillAssert(value: unknown, code: SkillErrorCode, field = ""): asserts value {
  if (!value) throw new SkillContractError(code, field);
}
