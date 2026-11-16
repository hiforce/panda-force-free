import { test, expect } from "bun:test";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { OpcPackage } from "../../src/server/packages/opc/package.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { XmlBudget, DEFAULT_XML_LIMITS, serializeXml } from "../../src/server/packages/opc/xml.js";
import { officeFixture } from "../support/office-presentation.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

for (const strict of [false, true])
  test(`native ${strict ? "Strict" : "Transitional"} package follows relationships, keeps order and projects editable objects`, async () => {
    const fixture = officeFixture({ strict, slides: 2 }),
      bytes = fixture.bytes(),
      pending = NativePresentation.open(bytes, "native.pptx");
    const original = new Uint8Array(bytes);
    bytes.fill(0);
    const source = await pending;
    expect(source.index.kind).toBe("pptx");
    expect(source.index.dialect).toBe(strict ? "strict" : "transitional");
    expect(source.main).toBe("deck/Root.xml");
    expect(source.index.slides.map((item) => item.name)).toEqual(["Page 1", "Page 2"]);
    expect(source.index.layouts[0]!.master).toBe("deck/style/master.xml");
    expect(source.index.size).toEqual({ width: 12192000, height: 6858000 });
    expect(source.index.masters[0]!.themes).toEqual(["deck/style/theme.xml"]);
    const part = source.part(source.index.slides[0]!.path);
    expect(part.shapes[0]!.text).toBe("Hello world\nNext line");
    expect(part.shapes[0]!.transform).toBeNull();
    expect(part.shapes[0]!.placeholder).toEqual({ index: "0", type: "obj" });
    expect(part.shapes[1]!.image).toEqual({
      part: "deck/media/hero%20photo.png",
      mediaType: "image/png",
      relationshipId: "rIdImage",
    });
    expect(part.shapes[1]!.transform).toMatchObject({
      x: 914400,
      y: 457200,
      width: 1828800,
      height: 914400,
      rotation: 15,
      flipH: true,
    });
    expect(part.shapes[2]!.children[0]!.text).toBe("Nested world\nNext line");
    expect(part.externalRelationships).toBe(1);
    expect(Object.isFrozen(source.index.slides[0])).toBe(true);
    expect(Object.isFrozen(part.shapes[2]!.children)).toBe(true);
    expect(source.original()).toEqual(original);
    source.original().fill(0);
    expect(source.original()).toEqual(original);
    const xml = source.parts.xml("deck/Root.xml");
    xml.documentElement!.setAttribute("mutated", "yes");
    expect(source.parts.xml("DECK/ROOT.XML").documentElement!.hasAttribute("mutated")).toBe(false);
    expect(source.parts.tree.read("opaque/data.bin")).toEqual(new Uint8Array([0, 1, 255, 0]));
  });

test("a zero-slide POTX retains its master and selectable layout without inventing example slides", async () => {
  const f = officeFixture({ kind: "potx", slides: 0 }),
    p = await NativePresentation.open(f.bytes(), "template.potx");
  expect(p.index.kind).toBe("potx");
  expect(p.index.slides).toEqual([]);
  expect(p.index.masters).toHaveLength(1);
  expect(p.index.layouts).toHaveLength(1);
  expect(p.part(p.index.layouts[0]!.path).shapes[0]!.placeholder?.type).toBe("ctrTitle");
});

test("unresolved, duplicate and incorrectly owned part relationships fail before accepting a native source", async () => {
  for (const mode of ["escape", "dangling", "duplicate", "wrong-owner"] as const) {
    const f = officeFixture(),
      files = { ...f.files };
    if (mode === "escape")
      files["_rels/.rels"] = String(files["_rels/.rels"]).replace("DECK/Root.xml", "../../outside.xml");
    if (mode === "dangling")
      files["deck/pages/_rels/p1.xml.rels"] = String(files["deck/pages/_rels/p1.xml.rels"]).replace(
        "hero%20photo.png",
        "absent.png",
      );
    if (mode === "duplicate")
      files["deck/pages/_rels/p1.xml.rels"] = String(files["deck/pages/_rels/p1.xml.rels"]).replace(
        'Id="external"',
        'Id="rIdImage"',
      );
    if (mode === "wrong-owner")
      files["deck/layouts/_rels/title.xml.rels"] = String(files["deck/layouts/_rels/title.xml.rels"]).replace(
        "../STYLE/MASTER.XML",
        "../pages/p1.xml",
      );
    await expect(NativePresentation.open(f.bytes(files), "bad.pptx")).rejects.toMatchObject({ code: "invalidPackage" });
  }
});

test("main content type, not a filename suffix, establishes the native format and rejects macro packages", async () => {
  const f = officeFixture({ kind: "potx" });
  expect((await NativePresentation.open(f.bytes(), "name.pptx")).index.kind).toBe("potx");
  const files = {
    ...f.files,
    "[Content_Types].xml": String(f.files["[Content_Types].xml"]).replace(
      "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
      "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
    ),
  };
  await expect(NativePresentation.open(f.bytes(files), "macro.potx")).rejects.toMatchObject({
    code: "unsupportedPackage",
  });
});

test("OPC URI aliases cannot make two physical ZIP files own the same logical image", async () => {
  const f = officeFixture(),
    files = { ...f.files, "deck/media/hero photo.png": new Uint8Array([0]) };
  const tree = await ImmutableSourceTree.create(
    Object.entries(files).map(([path, bytes]) => ({ path, bytes: typeof bytes === "string" ? utf8(bytes) : bytes })),
  );
  expect(() => new OpcPackage(tree)).toThrow("duplicatePart");
});

test("content-type comparison honors MIME case equivalence without rewriting the original package", async () => {
  const f = officeFixture(),
    files = {
      ...f.files,
      "[Content_Types].xml": String(f.files["[Content_Types].xml"]).replace(
        /ContentType="([^"]+)"/g,
        (_, type: string) => `ContentType="${type.toUpperCase()}"`,
      ),
    },
    bytes = f.bytes(files),
    p = await NativePresentation.open(bytes, "case.pptx");
  expect(p.index.kind).toBe("pptx");
  expect(p.part(p.index.slides[0]!.path).shapes[1]!.image?.mediaType).toBe("IMAGE/PNG");
  expect(p.original()).toEqual(bytes);
});

test("shape identities are numeric and unique across native groups", async () => {
  const f = officeFixture(),
    files = { ...f.files, "deck/pages/p1.xml": String(f.files["deck/pages/p1.xml"]).replace('id="5"', 'id="02"') };
  const p = await NativePresentation.open(f.bytes(files), "duplicate-shape.pptx");
  expect(() => p.part(p.index.slides[0]!.path)).toThrow("invalidPackage");
});

test("XML accepts UTF-8 and UTF-16, retains literal declarations as text and writes valid UTF-8 after editing", () => {
  for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
    const text = `<?xml version="1.0" encoding="${encoding === "utf-8" ? "UTF-8" : "UTF-16"}"?><x><![CDATA[<!DOCTYPE literal>]]> &amp; 原文</x>`;
    let bytes: Uint8Array;
    if (encoding === "utf-8") bytes = utf8(text);
    else {
      const buffer = Buffer.from("\ufeff" + text, "utf16le");
      if (encoding === "utf-16be") buffer.swap16();
      bytes = new Uint8Array(buffer);
    }
    const parsed = new XmlBudget().read(encoding, bytes);
    expect(parsed.documentElement!.textContent).toBe("<!DOCTYPE literal> & 原文");
    parsed.documentElement!.setAttribute("title", "a & b");
    const output = serializeXml(parsed);
    expect(new TextDecoder().decode(output)).toContain('encoding="UTF-8"');
    expect(new XmlBudget().read("again", output).documentElement!.getAttribute("title")).toBe("a & b");
  }
  expect(() => new XmlBudget().read("wrong", utf8('<?xml version="1.0" encoding="ISO-8859-1"?><x/>'))).toThrow(
    "unsupportedXmlEncoding",
  );
  expect(() => new XmlBudget().read("dtd", utf8('<!DOCTYPE x [<!ENTITY e "expansion">]><x>&e;</x>'))).toThrow(
    "invalidXml",
  );
});

test("XML allocation and structural limits are enforced before constructing an oversized DOM", () => {
  const limits = { ...DEFAULT_XML_LIMITS, partNodes: 10, nodes: 20, depth: 4, attributes: 2 };
  expect(() => new XmlBudget(limits).read("attrs", utf8('<x a="1" b="2" c="3"/>'))).toThrow("xmlLimitExceeded");
  expect(() => new XmlBudget(limits).read("depth", utf8("<x>".repeat(5) + "</x>".repeat(5)))).toThrow(
    "xmlLimitExceeded",
  );
  expect(() => new XmlBudget(limits).read("nodes", utf8("<x>" + "<y/>".repeat(20) + "</x>"))).toThrow(
    "xmlLimitExceeded",
  );
  const bounded = new XmlBudget({ ...DEFAULT_XML_LIMITS, totalBytes: 8 });
  bounded.read("one", utf8("<x/>"));
  bounded.read("two", utf8("<x/>"));
  expect(() => bounded.read("three", utf8("<x/>"))).toThrow("xmlLimitExceeded");
});

test("opaque extension objects remain in the original package and are declared outside editable projections", async () => {
  const f = officeFixture(),
    xml = String(f.files["deck/pages/p1.xml"]),
    extension =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback/></mc:AlternateContent>',
    files = { ...f.files, "deck/pages/p1.xml": xml.replace("</p:spTree>", extension + "</p:spTree>") },
    bytes = f.bytes(files),
    p = await NativePresentation.open(bytes, "extended.pptx");
  expect(p.part(p.index.slides[0]!.path).preservedOpaqueElements).toBe(1);
  expect(p.original()).toEqual(bytes);
});

test("XML failure diagnostics identify a validated part without exposing its source text", async () => {
  const f = officeFixture(),
    files = { ...f.files, "deck/Root.xml": '<!DOCTYPE private [<!ENTITY secret "private-body">]><private/>' };
  await expect(NativePresentation.open(f.bytes(files), "broken.pptx")).rejects.toMatchObject({
    code: "invalidPackage",
    part: "deck/Root.xml",
    message: "invalidPackage",
  });
});
