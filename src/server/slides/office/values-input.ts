import { slideAssert } from "../../../shared/slides/contracts.js";
import type { NativeContentMapping, NativeContentValues, NativeSlotValue } from "../../../shared/slides/mapping.js";

function image(value: Extract<NativeSlotValue, { kind: "image" }>) {
  const bytes = value.bytes;
  slideAssert(bytes instanceof Uint8Array && bytes.length <= 16 * 1024 * 1024, "invalidMapping");
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b),
    jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  slideAssert((value.mediaType === "image/png" && png) || (value.mediaType === "image/jpeg" && jpeg), "invalidMapping");
  return Object.freeze({ kind: "image" as const, mediaType: value.mediaType, bytes: new Uint8Array(bytes) });
}

/** All caller-owned values are captured synchronously before hashing or writing an output package. */
export function captureNativeValues(
  mapping: NativeContentMapping,
  input: NativeContentValues,
): Map<string, NativeSlotValue> {
  slideAssert(input && typeof input === "object" && !Array.isArray(input), "invalidMapping");
  const slots = new Map(mapping.slots.map((slot) => [slot.id, slot])),
    result = new Map<string, NativeSlotValue>();
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    const slot = slots.get(key);
    slideAssert(slot && value && value.kind === slot.kind, "invalidMapping");
    if (value.kind === "text") {
      slideAssert(
        typeof value.text === "string" &&
          value.text.length <= 100000 &&
          !/[\p{Cc}\p{Cs}\ufffe\uffff]/u.test(value.text.replace(/[\t\n\r]/g, "")),
        "invalidMapping",
      );
      const text = value.text.replace(/\r\n?/g, "\n");
      slideAssert(text.split("\n").length <= 1000 && (!slot.required || text.trim().length > 0), "invalidMapping");
      total += text.length * 4;
      result.set(key, Object.freeze({ kind: "text", text }));
    } else {
      const captured = image(value);
      total += captured.bytes.length;
      result.set(key, captured);
    }
    slideAssert(total <= 32 * 1024 * 1024, "limitExceeded");
  }
  slideAssert(
    mapping.slots.every((slot) => !slot.required || result.has(slot.id)),
    "invalidMapping",
  );
  return result;
}
