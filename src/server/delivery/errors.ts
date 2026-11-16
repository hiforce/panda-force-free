export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
/** Only adapters that proved no activation was dispatched may report an unchanged live target. */
export class PublicationEffectError extends DeliveryError {
  constructor(
    code: string,
    readonly outcome: "unchanged" | "unknown",
  ) {
    super(code, 409);
  }
}
