import type { JsonValue } from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";

/** Refuse lossy or executable values before hashing an immutable request or storing a remote receipt. */
export function workflowJson(value: JsonValue, maxBytes: number): string {
  const seen = new Set<object>();
  function validate(item: unknown, depth: number): JsonValue {
    if (depth > 40) throw new DeliveryError("invalidInput");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) throw new DeliveryError("invalidInput");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
      throw new DeliveryError("invalidInput");
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length) throw new DeliveryError("invalidInput");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some((part) => part.get || part.set)) throw new DeliveryError("invalidInput");
    const normalized: JsonValue = Array.isArray(item)
      ? Array.from(item, (part) => validate(part, depth + 1))
      : Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, validate(descriptors[key]!.value, depth + 1)]),
        );
    seen.delete(item);
    return normalized;
  }
  const payload = JSON.stringify(validate(value, 0));
  if (Buffer.byteLength(payload) > maxBytes) throw new DeliveryError("invalidInput");
  return payload;
}
