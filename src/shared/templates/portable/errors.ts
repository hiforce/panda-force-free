export type PortableTemplateErrorCode =
  | "invalidManifest"
  | "invalidBundle"
  | "invalidPath"
  | "resourceMismatch"
  | "resourceMissing"
  | "packageTooLarge"
  | "unsupportedType"
  | "incompatibleAdapter"
  | "invalidPayload"
  | "invalidParameters"
  | "unknownPlaceholder";
export class PortableTemplateError extends Error {
  constructor(readonly code: PortableTemplateErrorCode) {
    super(code);
    this.name = "PortableTemplateError";
  }
}
export function templateAssert(value: unknown, code: PortableTemplateErrorCode = "invalidManifest"): asserts value {
  if (!value) throw new PortableTemplateError(code);
}
