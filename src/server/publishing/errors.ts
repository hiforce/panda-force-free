export type PublicationErrorCode =
  | "invalidInput"
  | "unknownTemplate"
  | "invalidTemplate"
  | "staleTemplate"
  | "notFound"
  | "staleSource"
  | "staleVariant"
  | "reviewRequired"
  | "blockedContent"
  | "unsupportedMode"
  | "exportTooLarge"
  | "threadTooLong"
  | "assetUnavailable"
  | "unavailable"
  | "crossOrigin";
export class PublicationError extends Error {
  constructor(
    readonly code: PublicationErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}
