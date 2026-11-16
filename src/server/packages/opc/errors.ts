export class OpcError extends Error {
  constructor(
    readonly code:
      | "invalidXml"
      | "unsupportedXmlEncoding"
      | "xmlLimitExceeded"
      | "invalidPartName"
      | "duplicatePart"
      | "missingPart"
      | "invalidContentTypes"
      | "invalidRelationships",
    readonly part?: string,
  ) {
    super(code);
    this.name = "OpcError";
  }
}

export function opcAssert(value: unknown, code: OpcError["code"]): asserts value {
  if (!value) throw new OpcError(code);
}
