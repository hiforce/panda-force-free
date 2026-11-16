/** Storage errors stay independent of transport and localization. */
export class ProjectContentError extends Error {
  constructor(
    readonly code:
      | "invalidFile"
      | "unsupportedSchema"
      | "conflict"
      | "workingCopyChanged"
      | "unowned"
      | "unavailable"
      | "notFound"
      | "tooLarge",
  ) {
    super("Project content " + code);
  }
}
