import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentError } from "./errors.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";

/** Portable metadata is closed JSON, not executable configuration or a second body database. */
export function encodeContentJson<T>(value: T, validate: (value: unknown) => T, order?: readonly string[]): string {
  let normalized = JSON.parse(stableJson(validate(value)));
  if (order) {
    const keys = Object.keys(normalized);
    if (new Set(order).size !== keys.length || keys.some((key) => !order.includes(key)))
      throw new ProjectContentError("invalidFile");
    normalized = Object.fromEntries(order.map((key) => [key, normalized[key]]));
  }
  const bytes = JSON.stringify(normalized, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > PROJECT_CONTENT_LIMITS.fileBytes) throw new ProjectContentError("invalidFile");
  return bytes;
}
export function decodeContentJson<T>(input: Uint8Array | string, validate: (value: unknown) => T): T {
  if (Buffer.byteLength(input) > PROJECT_CONTENT_LIMITS.fileBytes) throw new ProjectContentError("invalidFile");
  try {
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    return validate(JSON.parse(text));
  } catch (error) {
    if (error instanceof ProjectContentError) throw error;
    throw new ProjectContentError("invalidFile");
  }
}
