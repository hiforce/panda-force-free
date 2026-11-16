import { slideAssert, type NativeSlideShape } from "../../../shared/slides/contracts.js";
import type { NativeContentMapping, NativeContentSlot } from "../../../shared/slides/mapping.js";
import type { NativePresentation } from "./package.js";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  slideAssert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    "invalidMapping",
  );
  return value as Record<string, unknown>;
}
export function findNativeShape(shapes: readonly NativeSlideShape[], id: string): NativeSlideShape | undefined {
  for (const shape of shapes) {
    if (shape.id === id) return shape;
    const child = findNativeShape(shape.children, id);
    if (child) return child;
  }
  return undefined;
}

/** Bindings use immutable source identity and native drawing IDs, never titles or DOM positions. */
export function nativeContentMapping(source: NativePresentation, value: unknown): NativeContentMapping {
  const input = record(value, ["schema", "sourceSha256", "slots"]);
  slideAssert(
    input.schema === "panda.powerpoint-mapping/v1" && input.sourceSha256 === source.index.source.sha256,
    "invalidMapping",
  );
  slideAssert(Array.isArray(input.slots) && input.slots.length <= 256, "invalidMapping");
  const ids = new Set<string>(),
    targets = new Set<string>(),
    models = new Map<string, readonly NativeSlideShape[]>();
  const slots = input.slots.map((value): NativeContentSlot => {
    const slot = record(value, ["id", "label", "kind", "target", "required"]),
      target = record(slot.target, ["part", "shapeId"]);
    slideAssert(
      typeof slot.id === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(slot.id) && !ids.has(slot.id),
      "invalidMapping",
    );
    slideAssert(
      typeof slot.label === "string" &&
        slot.label.length > 0 &&
        slot.label.length <= 256 &&
        !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(slot.label),
      "invalidMapping",
    );
    slideAssert(
      (slot.kind === "text" || slot.kind === "image") && typeof slot.required === "boolean",
      "invalidMapping",
    );
    slideAssert(typeof target.part === "string" && typeof target.shapeId === "string", "invalidMapping");
    const part = [...source.index.slides, ...source.index.layouts].find((item) => item.path === target.part);
    slideAssert(
      part && /^(?:0|[1-9][0-9]{0,9})$/.test(target.shapeId) && Number(target.shapeId) <= 0xffffffff,
      "invalidMapping",
    );
    if (!models.has(part.path)) models.set(part.path, source.part(part.path).shapes);
    const key = part.path + "\0" + target.shapeId,
      shape = findNativeShape(models.get(part.path)!, target.shapeId);
    slideAssert(shape && !targets.has(key), "invalidMapping");
    slideAssert(
      slot.kind === "text"
        ? shape.kind === "text" && shape.placeholder?.type !== "pic"
        : (shape.kind === "picture" && shape.image) || shape.placeholder?.type === "pic",
      "unsupportedShape",
    );
    ids.add(slot.id);
    targets.add(key);
    return Object.freeze({
      id: slot.id,
      label: slot.label,
      kind: slot.kind,
      required: slot.required,
      target: Object.freeze({ part: part.path, shapeId: target.shapeId }),
    });
  });
  return Object.freeze({
    schema: "panda.powerpoint-mapping/v1",
    sourceSha256: source.index.source.sha256,
    slots: Object.freeze(slots),
  });
}
