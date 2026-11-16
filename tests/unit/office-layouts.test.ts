import { expect, test } from "bun:test";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { composeNativeLayouts } from "../../src/server/slides/office/compose.js";
import { applyNativeContent } from "../../src/server/slides/office/apply.js";
import { officeFixture } from "../support/office-presentation.js";
import { OFFICE_CONTENT_TYPES } from "../../src/server/slides/office/namespaces.js";
import type { NativeContentMapping } from "../../src/shared/slides/mapping.js";

const png = () =>
  new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

test("layout composition follows each selected layout to its own master across a multi-master template", async () => {
  const fixture = officeFixture({ kind: "potx", slides: 0 }),
    files = { ...fixture.files };
  files["[Content_Types].xml"] = String(files["[Content_Types].xml"]).replace(
    "</Types>",
    `<Override PartName="/deck/style/secondary.xml" ContentType="${OFFICE_CONTENT_TYPES.master}"/><Override PartName="/deck/layouts/secondary.xml" ContentType="${OFFICE_CONTENT_TYPES.layout}"/></Types>`,
  );
  files["deck/Root.xml"] = String(files["deck/Root.xml"]).replace(
    "</p:sldMasterIdLst>",
    '<p:sldMasterId id="2147483650" r:id="master2"/></p:sldMasterIdLst>',
  );
  files["deck/_rels/Root.xml.rels"] = String(files["deck/_rels/Root.xml.rels"]).replace(
    "</Relationships>",
    `<Relationship Id="master2" Type="${fixture.ns.r}/slideMaster" Target="style/secondary.xml"/></Relationships>`,
  );
  files["deck/style/secondary.xml"] = String(files["deck/style/master.xml"])
    .replace('name="Master"', 'name="Secondary master"')
    .replace('id="2147483649"', 'id="2147483651"');
  files["deck/style/_rels/secondary.xml.rels"] = String(files["deck/style/_rels/master.xml.rels"]).replace(
    "../layouts/title.xml",
    "../layouts/secondary.xml",
  );
  files["deck/layouts/secondary.xml"] = String(files["deck/layouts/title.xml"]).replace(
    "Title layout",
    "Secondary layout",
  );
  files["deck/layouts/_rels/secondary.xml.rels"] = String(files["deck/layouts/_rels/title.xml.rels"]).replace(
    "../STYLE/MASTER.XML",
    "../style/secondary.xml",
  );
  const source = await NativePresentation.open(fixture.bytes(files), "multi.potx"),
    [primary, secondary] = source.index.layouts;
  expect(source.index.masters).toHaveLength(2);
  const output = await composeNativeLayouts(
      source,
      {
        schema: "panda.powerpoint-mapping/v1",
        sourceSha256: source.index.source.sha256,
        slots: [
          {
            id: "primary",
            label: "Primary",
            kind: "text",
            required: true,
            target: { part: primary!.path, shapeId: "2" },
          },
          {
            id: "secondary",
            label: "Secondary",
            kind: "text",
            required: true,
            target: { part: secondary!.path, shapeId: "2" },
          },
        ],
      },
      [
        { layout: secondary!.path, values: { secondary: { kind: "text", text: "Second master first" } } },
        { layout: primary!.path, values: { primary: { kind: "text", text: "First master second" } } },
      ],
    ),
    generated = await NativePresentation.open(output.bytes, "composed.pptx");
  expect(generated.index.slides.map((slide) => slide.master)).toEqual([secondary!.master, primary!.master]);
  expect(generated.index.slides.map((slide) => generated.part(slide.path).shapes[0]!.text)).toEqual([
    "Second master first",
    "First master second",
  ]);
  for (const part of [...source.index.layouts, ...source.index.masters])
    expect(generated.parts.tree.read(part.path)).toEqual(source.parts.tree.read(part.path));
});
function mapping(source: NativePresentation, image = false): NativeContentMapping {
  const layout = source.index.layouts[0]!;
  return {
    schema: "panda.powerpoint-mapping/v1",
    sourceSha256: source.index.source.sha256,
    slots: [
      { id: "title", label: "Title", kind: "text", required: true, target: { part: layout.path, shapeId: "2" } },
      ...(image
        ? [
            {
              id: "image",
              label: "Image",
              kind: "image" as const,
              required: true,
              target: { part: layout.path, shapeId: "3" },
            },
          ]
        : []),
    ],
  };
}

for (const strict of [false, true])
  test(`zero-slide ${strict ? "Strict" : "Transitional"} POTX creates an ordered deck from editable native layout placeholders`, async () => {
    const fixture = officeFixture({ strict, kind: "potx", slides: 0 }),
      bytes = fixture.bytes(),
      source = await NativePresentation.open(bytes, "template.potx"),
      layout = source.index.layouts[0]!.path,
      output = await composeNativeLayouts(source, mapping(source), [
        { layout, values: { title: { kind: "text", text: "First page" } } },
        { layout, values: { title: { kind: "text", text: "Second <page> & 😀" } } },
      ]),
      generated = await NativePresentation.open(output.bytes, "deck.pptx");
    expect(generated.index.kind).toBe("pptx");
    expect(generated.index.dialect).toBe(strict ? "strict" : "transitional");
    expect(generated.index.slides).toHaveLength(2);
    expect(generated.index.slides.map((s) => generated.part(s.path).shapes[0]!.text)).toEqual([
      "First page",
      "Second <page> & 😀",
    ]);
    expect(generated.index.slides.every((s) => s.layout === layout && s.master === source.index.masters[0]!.path)).toBe(
      true,
    );
    expect(generated.part(generated.index.slides[0]!.path).shapes[0]!.placeholder?.type).toBe("ctrTitle");
    for (const path of [...source.index.layouts, ...source.index.masters].map((item) => item.path))
      expect(generated.parts.tree.read(path)).toEqual(source.parts.tree.read(path));
    expect(generated.parts.tree.has("opaque/data.bin")).toBe(false);
    expect(source.original()).toEqual(bytes);
    expect(output.mode).toBe("compose-native-layouts");
  });

test("layout composition removes unselected sample slide parts and their content type entries", async () => {
  const source = await NativePresentation.open(officeFixture({ kind: "potx", slides: 2 }).bytes(), "samples.potx"),
    output = await composeNativeLayouts(source, mapping(source), [
      { layout: source.index.layouts[0]!.path, values: { title: { kind: "text", text: "Only new content" } } },
    ]),
    generated = await NativePresentation.open(output.bytes, "generated.pptx");
  expect(generated.index.slides).toHaveLength(1);
  for (const page of source.index.slides) expect(generated.parts.tree.has(page.path)).toBe(false);
  expect(generated.parts.tree.has("deck/pages/_rels/p1.xml.rels")).toBe(false);
  expect(generated.parts.tree.text("[Content_Types].xml")).not.toContain("/deck/pages/");
  expect(generated.part(generated.index.slides[0]!.path).shapes[0]!.text).toBe("Only new content");
});

for (const strict of [false, true])
  test(`new ${strict ? "Strict" : "Transitional"} compositions remove stale thumbnails and title metadata while keeping provenance`, async () => {
    const fixture = officeFixture({ kind: "potx", slides: 2, strict }),
      files = { ...fixture.files };
    files["_rels/.rels"] = String(files["_rels/.rels"]).replace(
      "</Relationships>",
      '<Relationship Id="thumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="metadata/thumb.png"/>' +
        `<Relationship Id="props" Type="${fixture.ns.r}/${strict ? "extendedProperties" : "extended-properties"}" Target="metadata/app.xml"/></Relationships>`,
    );
    files["metadata/thumb.png"] = png();
    files["metadata/app.xml"] =
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Template publisher</Company><Slides>2</Slides><TitlesOfParts>Private source slide title</TitlesOfParts><HeadingPairs>Source pages</HeadingPairs></Properties>';
    const source = await NativePresentation.open(fixture.bytes(files), "source.potx"),
      output = await composeNativeLayouts(source, mapping(source), [
        { layout: source.index.layouts[0]!.path, values: { title: { kind: "text", text: "New page" } } },
      ]),
      generated = await NativePresentation.open(output.bytes, "new.pptx"),
      properties = generated.parts.tree.text("metadata/app.xml");
    expect(generated.parts.tree.has("metadata/thumb.png")).toBe(false);
    expect(properties).toContain("<Slides>1</Slides>");
    expect(properties).not.toContain("Private source slide title");
    expect(properties).not.toContain("HeadingPairs");
    expect(properties).toContain("Template publisher");
    expect(output.templateMetadataPreserved).toBe(true);
  });

test("native picture placeholders become editable image objects with independent bytes on each new page", async () => {
  const fixture = officeFixture({ kind: "potx", slides: 0 }),
    files = { ...fixture.files };
  files["deck/layouts/title.xml"] = String(files["deck/layouts/title.xml"]).replace(
    "</p:spTree>",
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Picture slot"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="4"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="100" cy="80"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Picture</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>',
  );
  const source = await NativePresentation.open(fixture.bytes(files), "pictures.potx"),
    layout = source.index.layouts[0]!.path,
    bytes = png(),
    pending = composeNativeLayouts(source, mapping(source, true), [
      {
        layout,
        values: { title: { kind: "text", text: "One" }, image: { kind: "image", mediaType: "image/png", bytes } },
      },
      {
        layout,
        values: { title: { kind: "text", text: "Two" }, image: { kind: "image", mediaType: "image/png", bytes } },
      },
    ]);
  bytes.fill(0);
  const output = await pending,
    generated = await NativePresentation.open(output.bytes, "pictures.pptx"),
    pictures = generated.index.slides.map((s) => generated.part(s.path).shapes.find((shape) => shape.id === "3")!);
  expect(pictures.every((pic) => pic.kind === "picture" && pic.placeholder?.index === "4")).toBe(true);
  expect(pictures[0]!.image!.part).not.toBe(pictures[1]!.image!.part);
  for (const picture of pictures) {
    expect(generated.parts.tree.read(picture.image!.part)).toEqual(png());
    expect(picture.transform).toMatchObject({ x: 10, y: 20, width: 100, height: 80 });
  }
});

test("layout mappings and source-deck mappings cannot accidentally edit a shared master or use each other's workflow", async () => {
  const source = await NativePresentation.open(officeFixture().bytes(), "source.pptx"),
    m = mapping(source);
  await expect(applyNativeContent(source, m, { title: { kind: "text", text: "Wrong mode" } })).rejects.toMatchObject({
    code: "invalidMapping",
  });
  const slideMapping = {
    ...m,
    slots: m.slots.map((slot) => ({ ...slot, target: { ...slot.target, part: source.index.slides[0]!.path } })),
  };
  await expect(
    composeNativeLayouts(source, slideMapping, [{ layout: source.index.layouts[0]!.path, values: {} }]),
  ).rejects.toMatchObject({ code: "invalidMapping" });
  await expect(composeNativeLayouts(source, m, [{ layout: "missing.xml", values: {} }])).rejects.toMatchObject({
    code: "invalidMapping",
  });
  await expect(composeNativeLayouts(source, m, [])).rejects.toMatchObject({ code: "invalidMapping" });
  await expect(
    composeNativeLayouts(source, m, [{ layout: source.index.layouts[0]!.path, values: {} }]),
  ).rejects.toMatchObject({ code: "invalidMapping" });
});
