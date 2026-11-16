import type { NativeContentMapping, NativeContentSlot } from "../../shared/slides/mapping.js";
import type { NativeSlideShape } from "../../shared/slides/contracts.js";

const key = (part: string, shapeId: string) => JSON.stringify([part, shapeId]);
export function editableNativeObjects(
  shapes: readonly NativeSlideShape[],
): { shape: NativeSlideShape; kind: "text" | "image" }[] {
  return shapes.flatMap((shape) => {
    if (shape.placeholder?.type === "pic" || (shape.kind === "picture" && shape.image))
      return [{ shape, kind: "image" as const }];
    if (shape.kind === "text") return [{ shape, kind: "text" as const }];
    return editableNativeObjects(shape.children);
  });
}
/** A draft owns mappings across part navigation; DOM pagination and async reads cannot replace another part's edits. */
export class NativeSlidesMappingDraft {
  private slots = new Map<string, NativeContentSlot>();
  constructor(
    private sha256: string,
    seed?: NativeContentMapping,
  ) {
    if (seed)
      for (const slot of seed.slots) this.slots.set(key(slot.target.part, slot.target.shapeId), structuredClone(slot));
  }
  get(part: string, shapeId: string) {
    const slot = this.slots.get(key(part, shapeId));
    return slot ? structuredClone(slot) : undefined;
  }
  count() {
    return this.slots.size;
  }
  select(part: string, shape: NativeSlideShape, kind: "text" | "image", selected: boolean) {
    const target = key(part, shape.id);
    if (!selected) {
      this.slots.delete(target);
      return;
    }
    if (this.slots.has(target)) return;
    if (this.slots.size >= 256) throw Error("mappingLimit");
    let index = this.slots.size + 1;
    const ids = new Set([...this.slots.values()].map((slot) => slot.id));
    while (ids.has("slot_" + index)) index++;
    const id = "slot_" + index;
    this.slots.set(target, {
      id,
      label:
        shape.name
          .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
          .trim()
          .slice(0, 256) || id,
      kind,
      required: false,
      target: { part, shapeId: shape.id },
    });
  }
  update(part: string, shapeId: string, value: { id: string; label: string; required: boolean }) {
    const target = key(part, shapeId),
      prior = this.slots.get(target);
    if (prior) this.slots.set(target, { ...prior, ...value });
  }
  snapshot(): NativeContentMapping {
    const slots = [...this.slots.values()],
      ids = new Set<string>();
    for (const slot of slots) {
      if (
        !/^[a-z][a-z0-9_-]{0,63}$/.test(slot.id) ||
        ids.has(slot.id) ||
        !slot.label.trim() ||
        slot.label.length > 256 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(slot.label)
      )
        throw Error("invalidMapping");
      ids.add(slot.id);
    }
    return { schema: "panda.powerpoint-mapping/v1", sourceSha256: this.sha256, slots: structuredClone(slots) };
  }
}
