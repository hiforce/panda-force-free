export type PluginRegistryErrorCode =
  | "registryConflict"
  | "immutableVersion"
  | "packageNotInstalled"
  | "packageDisabled"
  | "exportUnavailable"
  | "packageUnavailable"
  | "reviewChanged"
  | "approvalRequired"
  | "crossOrigin"
  | "identityRequired"
  | "unsupportedSchema"
  | "invalidLibraryDraft"
  | "libraryNotFound"
  | "libraryConflict"
  | "libraryPublished"
  | "libraryUnverified"
  | "sampleBusy"
  | "sampleConflict"
  | "sampleNotFound"
  | "sampleArtifactUnavailable"
  | "libraryStorageFull";

export class PluginRegistryError extends Error {
  constructor(readonly code: PluginRegistryErrorCode) {
    super(code);
    this.name = "PluginRegistryError";
  }
}
