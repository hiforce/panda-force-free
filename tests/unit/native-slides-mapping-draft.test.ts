import { expect, test } from "bun:test";
import {
  NativeSlidesMappingDraft,
  editableNativeObjects,
} from "../../src/client/templates/native-slides-mapping-model.js";
import type { NativeSlideShape } from "../../src/shared/slides/contracts.js";

const shape = (id: string): NativeSlideShape => ({
  id,
  name: "Title",
  kind: "text",
  placeholder: null,
  transform: null,
  text: "Editable title",
  image: null,
  children: [],
});
test("part navigation keeps independent editable slots, validates IDs and returns detached snapshots", () => {
  const draft = new NativeSlidesMappingDraft("a".repeat(64));
  draft.select("ppt/slides/a.xml", shape("2"), "text", true);
  draft.update("ppt/slides/a.xml", "2", { id: "title", label: "Document title", required: true });
  draft.select("ppt/slides/b.xml", shape("2"), "text", true);
  expect(draft.snapshot().slots[0]!.id).toBe("title");
  Reflect.set(draft.snapshot().slots[0]!.target, "part", "forged");
  expect(draft.get("ppt/slides/a.xml", "2")!.target.part).toBe("ppt/slides/a.xml");
  draft.update("ppt/slides/b.xml", "2", { id: "title", label: "Duplicate", required: false });
  expect(() => draft.snapshot()).toThrow("invalidMapping");
  draft.select("ppt/slides/b.xml", shape("2"), "text", false);
  expect(draft.snapshot().slots).toHaveLength(1);
});
test("native picture placeholders are image slots even when represented by a text-shaped XML node", () => {
  const picture = { ...shape("3"), placeholder: { type: "pic", index: "1" } };
  expect(
    editableNativeObjects([{ ...shape("1"), kind: "group", children: [picture] }]).map((value) => value.kind),
  ).toEqual(["image"]);
});
