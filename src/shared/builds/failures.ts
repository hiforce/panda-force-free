/** Public failure categories cross the executor boundary without carrying daemon or registry responses. */
const failures: Record<string, string> = {
  cancelled: "cancelled",
  executorRestarted: "executorRestarted",
  executorStorageFull: "executorStorageFull",
  imageNotAvailableLocally: "imageUnavailable",
  imagePullFailed: "imagePullFailed",
  imageInspectionFailed: "imageUnavailable",
  invalidImageIdentity: "incompatibleImage",
  themeWorkerRequired: "themeWorkerRequired",
  trustedThemeWorkerRequired: "trustedThemeWorkerRequired",
  profileThemeWorkerRequired: "profileThemeWorkerRequired",
  sourceProjectWorkerRequired: "sourceProjectWorkerRequired",
  resourceBuildWorkerRequired: "incompatibleImage",
  themeDependencyUnavailable: "themeDependencyUnavailable",
  hexoStylusWorkerRequired: "hexoStylusWorkerRequired",
  sourceResourceConflict: "sourceResourceConflict",
  incompatibleWorkerImage: "incompatibleImage",
  registryConfigurationUnavailable: "registryCredentialsUnavailable",
  registryCredentialsMissing: "registryCredentialsUnavailable",
  registryCredentialsInvalid: "registryCredentialsUnavailable",
  registryCredentialHelperUnsupported: "registryHelperUnsupported",
  engineBuildFailed: "buildFailed",
  buildTimeout: "buildTimeout",
  artifactTooLarge: "outputTooLarge",
  workerOutputTooLarge: "outputTooLarge",
  themeDigestMismatch: "inputDigestMismatch",
  inputDigestMismatch: "inputDigestMismatch",
  artifactDigestMismatch: "artifactDigestMismatch",
};

/** Older executors already return some public categories; keep them compatible. */
export function executionFailure(code: unknown): string {
  if (typeof code !== "string") return "buildFailed";
  return Object.hasOwn(failures, code)
    ? failures[code]!
    : Object.values(failures).includes(code)
      ? code
      : "buildFailed";
}
