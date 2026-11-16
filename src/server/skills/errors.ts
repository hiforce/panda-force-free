export type SkillRegistryErrorCode =
  | "unavailable"
  | "unsupportedSchema"
  | "registryConflict"
  | "reviewChanged"
  | "immutableVersion"
  | "notInstalled"
  | "skillDisabled"
  | "approvalRequired"
  | "invalidInput"
  | "operationConflict"
  | "notFound";
export class SkillRegistryError extends Error {
  constructor(readonly code: SkillRegistryErrorCode) {
    super(code);
    this.name = "SkillRegistryError";
  }
}
