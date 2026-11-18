import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CreationOriginalSources,
  CreationOriginalError,
} from "../../src/server/creation/integration/rendering/original-source.js";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.js";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { applyNativeContent } from "../../src/server/slides/office/apply.js";
import { imageDigest } from "../../src/server/creation/integration/rendering/image-result.js";
import type { CreationMaterial } from "../../src/shared/creation/contracts.js";

const noImage = async () => {
  throw Error("No image requested");
};
test("editable presentation cover and content placeholders keep title and body bounds separate", async () => {
  const result = await renderCreationSlides(
      [
        { layout: "cover", title: "计算机发展史", body: "从机械计算到人工智能" },
        { layout: "content", title: "电子计算机", body: "电子管推动通用计算" },
      ],
      noImage,
    ),
    deck = await NativePresentation.open(result.bytes, "Actual.pptx");
  for (const page of deck.index.slides) {
    const shapes = deck.part(page.path).shapes,
      title = shapes.find((s) => s.id === "2")?.transform,
      body = shapes.find((s) => s.id === "3")?.transform;
    expect(title?.y).toBeNumber();
    expect(title?.height).toBeNumber();
    expect(body?.y).toBeNumber();
    if (!title || title.y === null || title.height === null || !body || body.y === null)
      throw Error("Missing layout bounds");
    expect(body.y).toBeGreaterThanOrEqual(title.y + title.height);
  }
});
test("original source reads require authorized captured materials and complete page coverage before native edits", async () => {
  const created = await renderCreationSlides(
      [{ layout: "cover", title: "Original title", body: "Original subtitle" }],
      noImage,
    ),
    deck = await NativePresentation.open(created.bytes, "Original.pptx"),
    long = await applyNativeContent(
      deck,
      {
        schema: "panda.powerpoint-mapping/v1",
        sourceSha256: deck.index.source.sha256,
        slots: [
          {
            id: "title",
            label: "Title",
            kind: "text",
            required: true,
            target: { part: deck.index.slides[0]!.path, shapeId: "2" },
          },
        ],
      },
      { title: { kind: "text", text: "Original ".repeat(2000) } },
    ),
    material: CreationMaterial = {
      id: randomUUID(),
      name: "Original.pptx",
      kind: "file",
      digest: imageDigest(long.bytes),
    };
  let sourceReads = 0;
  const sources = new CreationOriginalSources(
    { owner: "owner", taskId: randomUUID() },
    async () => {
      throw Error("No arbitrary asset read");
    },
    async () => [material],
    {
      prepare: async () => [],
      read: async () => ({ success: false, text: "unused" }),
      async readOriginal(owner, selected) {
        expect(owner).toBe("owner");
        expect(selected).toEqual(material);
        sourceReads++;
        return long.bytes;
      },
    },
  );
  await expect(sources.read({ materialId: randomUUID() })).rejects.toThrow();
  expect(sourceReads).toBe(0);
  await expect(sources.read({ materialId: material.id, offset: 1 })).rejects.toThrow();
  const first = JSON.parse((await sources.read({ materialId: material.id })).text),
    slot = first.text.match(/"slot":"([^"]+)"/)[1];
  expect(first.nextOffset).toBeGreaterThan(0);
  await expect(
    sources.editSlides({ slot: 1, sourceId: first.sourceId, changes: [{ slot, text: "Updated title" }] }, noImage),
  ).rejects.toBeInstanceOf(CreationOriginalError);
  const second = JSON.parse((await sources.read({ materialId: material.id, offset: first.nextOffset })).text);
  expect(second.nextOffset).toBe(null);
  await expect(
    sources.editSlides({ slot: 1, sourceId: "a".repeat(64), changes: [{ slot, text: "Wrong original" }] }, noImage),
  ).rejects.toThrow();
  await expect(
    sources.editSlides(
      { slot: 1, sourceId: first.sourceId, changes: [{ slot: "s-guessed", text: "Wrong slot" }] },
      noImage,
    ),
  ).rejects.toThrow();
  const edited = await sources.editSlides(
      { slot: 1, sourceId: first.sourceId, changes: [{ slot, text: "Updated title" }] },
      noImage,
    ),
    result = await NativePresentation.open(edited.bytes, "Updated.pptx");
  expect(result.part(result.index.slides[0]!.path).shapes.find((s) => s.id === "2")?.text).toBe("Updated title");
  expect(result.part(result.index.slides[0]!.path).shapes.find((s) => s.id === "3")?.text).toBe("Original subtitle");
  expect(deck.part(deck.index.slides[0]!.path).shapes.find((s) => s.id === "2")?.text).toBe("Original title");
});

test("HTML source resource retention requires complete original reading and rejects arbitrary resource names", async () => {
  const bytes = Buffer.from("<!doctype html><html><h1>Original</h1>" + "<p>Content</p>".repeat(1200) + "</html>"),
    material: CreationMaterial = { id: randomUUID(), name: "Original.html", kind: "file", digest: imageDigest(bytes) },
    sources = new CreationOriginalSources(
      { owner: "owner", taskId: randomUUID() },
      async () => {
        throw Error("No arbitrary asset read");
      },
      async () => [material],
      {
        prepare: async () => [],
        read: async () => ({ success: false, text: "unused" }),
        readOriginal: async () => bytes,
      },
    );
  let result = JSON.parse((await sources.read({ materialId: material.id })).text);
  await expect(sources.webResources(result.sourceId, [])).rejects.toBeInstanceOf(CreationOriginalError);
  while (result.nextOffset !== null)
    result = JSON.parse((await sources.read({ materialId: material.id, offset: result.nextOffset })).text);
  expect(await sources.webResources(result.sourceId, [])).toEqual([]);
  await expect(sources.webResources(result.sourceId, ["private.png"])).rejects.toThrow();
  await expect(sources.webResources("f".repeat(64), [])).rejects.toThrow();
});
