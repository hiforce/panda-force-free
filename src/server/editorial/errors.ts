export type EditorialErrorCode =
  | "invalidInput"
  | "notFound"
  | "staleSource"
  | "workingCopyChanged"
  | "staleProposal"
  | "alreadyApplied"
  | "unsupportedMode"
  | "unsupportedSource"
  | "invalidPatch"
  | "unavailable"
  | "crossOrigin";
export class EditorialError extends Error {
  constructor(
    readonly code: EditorialErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}
