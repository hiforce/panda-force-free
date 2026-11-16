/** Domain errors carry stable codes; HTTP and UI boundaries own localization. */
export type DocumentErrorCode =
  | "invalidInput"
  | "invalidRichBody"
  | "tooManyFolders"
  | "tooManyDocuments"
  | "invalidTreeMove"
  | "treeDepth"
  | "navigationConflict"
  | "tooManyPlacements"
  | "placementPathConflict"
  | "placementAlreadyLinked"
  | "invalidPlacementTarget"
  | "invalidPlacementMetadata"
  | "placementLocaleMismatch"
  | "placementSourceUnavailable"
  | "invalidSourceConfiguration"
  | "sourceResourcesTooLarge"
  | "sourceResourceConflict"
  | "sourceEditionMissing"
  | "unknownTheme"
  | "incompatibleTheme"
  | "spaceConflict"
  | "assetTooLarge"
  | "invalidImage"
  | "busy"
  | "languageConflict"
  | "notFound"
  | "conflict"
  | "workingCopyChanged"
  | "duplicate"
  | "outsideRoots"
  | "sourceUnavailable"
  | "unavailable"
  | "tooLarge"
  | "unsupportedSchema"
  | "crossOrigin";
export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    readonly status = 400,
  ) {
    super(`documents.${code}`);
    this.name = "DocumentError";
  }
}
