import { RemoteOperationError } from "../../workflows/errors.js";

export const xIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,19}$/.test(value);
export const invalidXInput = () => new RemoteOperationError("invalidInput", "rejected");
export const malformedXResponse = () => new RemoteOperationError("invalidPlatformResponse", "unknown");

/** A successful HTTP status alone is not evidence that the requested operation completed. */
export function xData(response: Record<string, unknown>): Record<string, unknown> {
  if (
    !response.data ||
    typeof response.data !== "object" ||
    Array.isArray(response.data) ||
    (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0))
  )
    throw malformedXResponse();
  return response.data as Record<string, unknown>;
}
