export class PortableRegistryError extends Error {
  constructor(
    readonly code:
      | "invalidInput"
      | "registryConflict"
      | "reviewChanged"
      | "immutableVersion"
      | "notInstalled"
      | "templateDisabled"
      | "operationConflict"
      | "unavailable"
      | "storageFull"
      | "draftConflict"
      | "draftNotFound"
      | "unsupportedAuthoring",
  ) {
    super(code);
    this.name = "PortableRegistryError";
  }
}
