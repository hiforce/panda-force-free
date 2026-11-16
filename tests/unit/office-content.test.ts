import { expect, test } from "bun:test";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { nativeContentMapping } from "../../src/server/slides/office/mapping.js";
import { applyNativeContent } from "../../src/server/slides/office/apply.js";
import { xmlChildren, xmlDescendants } from "../../src/server/packages/opc/xml.js";
import { OpcEdit } from "../../src/server/packages/opc/edit.js";
import { officeFixture } from "../support/office-presentation.js";

const png = () =>
  new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
function mapping(source: NativePresentation, shapeId = "2", kind: "text" | "image" = "text") {
  return {
    schema: "panda.powerpoint-mapping/v1",
    sourceSha256: source.index.source.sha256,
    slots: [
      { id: "title", label: "Title", kind, required: true, target: { part: source.index.slides[0]!.path, shapeId } },
    ],
  };
}

for (const strict of [false, true])
  test(`mapped ${strict ? "Strict" : "Transitional"} content stays editable and preserves all unmodified native parts`, async () => {
    const fixture = officeFixture({ strict, slides: 2, kind: "potx" }),
      original = fixture.bytes(),
      source = await NativePresentation.open(original, "source.potx"),
      output = await applyNativeContent(source, mapping(source), {
        title: { kind: "text", text: "New <title> & 😀\nSecond line" },
      }),
      generated = await NativePresentation.open(output.bytes, "generated.pptx");
    expect(generated.index.kind).toBe("pptx");
    expect(generated.index.dialect).toBe(strict ? "strict" : "transitional");
    expect(generated.part(generated.index.slides[0]!.path).shapes[0]!.text).toBe("New <title> & 😀\nSecond line");
    const body = generated.parts.xml(generated.index.slides[0]!.path),
      runs = xmlDescendants(body, fixture.ns.a, "r");
    expect(xmlChildren(runs[0]!, fixture.ns.a, "rPr")[0]!.getAttribute("b")).toBe("1");
    expect(generated.index.masters).toEqual(source.index.masters);
    expect(generated.index.layouts).toEqual(source.index.layouts);
    for (const file of source.parts.tree.files)
      if (!["[Content_Types].xml", source.index.slides[0]!.path].includes(file.path))
        expect(generated.parts.tree.read(file.path)).toEqual(source.parts.tree.read(file.path));
    expect(source.original()).toEqual(original);
    expect(output.sourceSha256).toBe(source.index.source.sha256);
    expect(output.sha256).not.toBe(output.sourceSha256);
    expect(output.mode).toBe("adapt-source-deck");
  });

test("nested group text uses native identity and optional unfilled slots keep source content", async () => {
  const source = await NativePresentation.open(officeFixture().bytes(), "native.pptx"),
    m = mapping(source, "5");
  m.slots[0]!.required = false;
  const omitted = await applyNativeContent(source, m, {}),
    unedited = await NativePresentation.open(omitted.bytes, "same.pptx"),
    updated = await applyNativeContent(source, m, { title: { kind: "text", text: "Nested update" } }),
    parsed = await NativePresentation.open(updated.bytes, "updated.pptx");
  expect(unedited.parts.tree.digest).toBe(source.parts.tree.digest);
  expect(parsed.part(parsed.index.slides[0]!.path).shapes[2]!.children[0]!.text).toBe("Nested update");
});

test("image replacement allocates a new native part and reference without changing shared media or geometry", async () => {
  const fixture = officeFixture({ slides: 2 }),
    source = await NativePresentation.open(fixture.bytes(), "native.pptx"),
    originalPart = source.part(source.index.slides[0]!.path),
    replacement = png(),
    before = new Uint8Array(replacement),
    pending = applyNativeContent(source, mapping(source, "3", "image"), {
      title: { kind: "image", mediaType: "image/png", bytes: replacement },
    });
  replacement.fill(0);
  const output = await pending,
    generated = await NativePresentation.open(output.bytes, "generated.pptx"),
    picture = generated.part(generated.index.slides[0]!.path).shapes[1]!,
    other = generated.part(generated.index.slides[1]!.path).shapes[1]!;
  expect(picture.transform).toEqual(originalPart.shapes[1]!.transform);
  expect(picture.image!.part).not.toBe(other.image!.part);
  expect(generated.parts.tree.read(picture.image!.part)).toEqual(before);
  expect(generated.parts.tree.read(other.image!.part)).toEqual(source.parts.tree.read(other.image!.part));
  expect(picture.image!.mediaType).toBe("image/png");
  expect(source.part(source.index.slides[0]!.path)).toEqual(originalPart);
});

test("mapping rejects stale sources, duplicate target authority, unknown fields and non-native shape identities", async () => {
  const source = await NativePresentation.open(officeFixture().bytes(), "native.pptx"),
    good = mapping(source);
  for (const bad of [
    { ...good, sourceSha256: "0".repeat(64) },
    { ...good, execute: true },
    { ...good, slots: [good.slots[0], { ...good.slots[0], id: "other" }] },
    { ...good, slots: [{ ...good.slots[0], target: { part: "deck/style/master.xml", shapeId: "2" } }] },
    mapping(source, "02"),
    mapping(source, "99999999999999999"),
    mapping(source, "99"),
  ])
    expect(() => nativeContentMapping(source, bad)).toThrow();
  expect(() => nativeContentMapping(source, mapping(source, "3"))).toThrow("unsupportedShape");
  const captured = nativeContentMapping(source, good);
  good.slots[0]!.label = "Changed";
  expect(captured.slots[0]!.label).toBe("Title");
  expect(Object.isFrozen(captured.slots[0]!.target)).toBe(true);
});

test("invalid and missing values fail without modifying the source", async () => {
  const source = await NativePresentation.open(officeFixture().bytes(), "native.pptx"),
    original = source.original(),
    m = mapping(source);
  await expect(applyNativeContent(source, m, {})).rejects.toMatchObject({ code: "invalidMapping" });
  await expect(applyNativeContent(source, m, { extra: { kind: "text", text: "extra" } })).rejects.toMatchObject({
    code: "invalidMapping",
  });
  for (const text of [" ", "bad\0text", "\ud800", "x".repeat(100001), "x\n".repeat(1001)])
    await expect(applyNativeContent(source, m, { title: { kind: "text", text } })).rejects.toMatchObject({
      code: "invalidMapping",
    });
  await expect(
    applyNativeContent(source, mapping(source, "3", "image"), {
      title: { kind: "image", mediaType: "image/jpeg", bytes: png() },
    }),
  ).rejects.toMatchObject({ code: "invalidMapping" });
  expect(source.original()).toEqual(original);
});

test("alternative image originals cannot silently override a replaced fallback", async () => {
  const fixture = officeFixture(),
    files = { ...fixture.files };
  files["deck/pages/p1.xml"] = String(files["deck/pages/p1.xml"]).replace(
    '<a:blip r:embed="rIdImage"/>',
    '<a:blip r:embed="rIdImage"><a:extLst><a:ext uri="svg"><svg:svgBlip xmlns:svg="urn:svg" r:embed="rIdImage"/></a:ext></a:extLst></a:blip>',
  );
  const source = await NativePresentation.open(fixture.bytes(files), "svg.pptx");
  await expect(
    applyNativeContent(source, mapping(source, "3", "image"), {
      title: { kind: "image", mediaType: "image/png", bytes: png() },
    }),
  ).rejects.toMatchObject({ code: "unsupportedShape" });
});

test("signed sources are not presented as valid after native content edits", async () => {
  const fixture = officeFixture(),
    files = { ...fixture.files };
  files["_rels/.rels"] = String(files["_rels/.rels"]).replace(
    "</Relationships>",
    '<Relationship Id="signature" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="opaque/signature.xml"/></Relationships>',
  );
  files["opaque/signature.xml"] = "<signature/>";
  const source = await NativePresentation.open(fixture.bytes(files), "signed.pptx");
  await expect(
    applyNativeContent(source, mapping(source), { title: { kind: "text", text: "New title" } }),
  ).rejects.toMatchObject({ code: "unsupportedPackage" });
});

test("new media part aliases cannot replace original files and exact inputs produce deterministic output", async () => {
  const source = await NativePresentation.open(officeFixture().bytes(), "source.pptx"),
    edit = new OpcEdit(source.parts);
  expect(() => edit.add("DECK/media/hero photo.png", png(), "image/png")).toThrow("duplicatePart");
  const m = mapping(source),
    values = { title: { kind: "text" as const, text: "Stable" } },
    first = await applyNativeContent(source, m, values),
    second = await applyNativeContent(source, m, values);
  expect(first.sha256).toBe(second.sha256);
  expect(first.mappingSha256).toBe(second.mappingSha256);
  expect(first.bytes).toEqual(second.bytes);
});
