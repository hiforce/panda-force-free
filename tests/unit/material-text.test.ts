import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extractMaterialText } from "../../src/server/materials/extractor.js";
import { MaterialTextWorkers } from "../../src/server/materials/workers.js";
import { MATERIAL_TEXT_LIMITS as limits } from "../../src/server/materials/contracts.js";
import { materialOffice, textPdf } from "../support/material-text.js";
import { officeFixture } from "../support/office-presentation.js";

test("local PDF extraction preserves caller bytes, Chinese mappings and ordered pages without network access", async () => {
  const bytes = textPdf({ chinese: true, pages: 2 }),
    original = new Uint8Array(bytes),
    fetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw Error("A local parser must not fetch");
  }) as typeof fetch;
  try {
    expect(await extractMaterialText("requirements.PDF", bytes)).toEqual({ text: "需求文档\n\n需求文档", sections: 2 });
    expect(bytes).toEqual(original);
    expect((await extractMaterialText("plain.pdf", textPdf())).text).toContain("acceptance criteria");
  } finally {
    globalThis.fetch = fetch;
  }
});
test("scanned, encrypted, corrupt and oversized attachments fail with owned categories", async () => {
  for (const [name, bytes, code] of [
    ["empty.pdf", textPdf({ text: "" }), "empty"],
    ["locked.pdf", textPdf({ encrypted: true }), "encrypted"],
    ["broken.pdf", Buffer.from("Not a PDF"), "unreadable"],
    ["pages.pdf", textPdf({ pages: 301 }), "tooLarge"],
    ["old.doc", new Uint8Array(), "unsupported"],
    ["large.docx", new Uint8Array(limits.inputBytes + 1), "tooLarge"],
    ["locked.xlsx", Buffer.from("d0cf11e0a1b11ae1", "hex"), "encrypted"],
  ] as const)
    await expect(extractMaterialText(name, bytes)).rejects.toMatchObject({ code });
});
for (const strict of [false, true]) {
  test(`Word text preserves paragraphs, tables and headers and excludes tracked deletions (${strict})`, async () => {
    const f = materialOffice("docx", strict),
      result = await extractMaterialText("requirements.docx", f.bytes());
    expect(result.text).toContain("需求文档 & acceptance");
    expect(result.text).toContain("Keep\ttab\nnext line");
    expect(result.text).toContain("Field\tRequired");
    expect(result.text).toContain("Header text");
    expect(result.text).not.toContain("Deleted text");
    expect(result.text).not.toContain("must-not-fetch.invalid");
  });
  test(`Excel text retains cell coordinates, raw values, formulas and merged ranges without evaluation (${strict})`, async () => {
    const f = materialOffice("xlsx", strict),
      result = await extractMaterialText("fields.xlsx", f.bytes());
    expect(result.text).toContain('"sheet":"产品"');
    expect(result.text).toContain('"merged":["A3:B3"]');
    expect(result.text).toContain('"ref":"A1","value":"字段"');
    expect(result.text).toContain('"ref":"A2","value":"true"');
    expect(result.text).toContain('"ref":"B2","value":"3","formula":"SUM(1,2)"');
    expect(result.sections).toBe(1);
  });
  test(`PowerPoint follows slide relationships and retains line breaks and notes (${strict})`, async () => {
    const f = officeFixture({ slides: 2, strict });
    f.files["deck/pages/_rels/p1.xml.rels"] = String(f.files["deck/pages/_rels/p1.xml.rels"]).replace(
      "</Relationships>",
      `<Relationship Id="notes" Type="${f.ns.r}/notesSlide" Target="notes.xml"/></Relationships>`,
    );
    f.files["deck/pages/notes.xml"] =
      `<p:notes xmlns:p="${f.ns.p}" xmlns:a="${f.ns.a}"><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:notes>`;
    const result = await extractMaterialText("deck.pptx", f.bytes());
    expect(result.text).toContain("Hello world\nNext line");
    expect(result.text).toContain("Nested world\nNext line");
    expect(result.text).toContain("Speaker notes");
    expect(result.sections).toBe(2);
    expect(result.text).not.toContain("outside.invalid");
  });
}
test("Office parsing rejects external document roots, XML entities, oversized shared-string expansion and empty workbooks", async () => {
  const external = materialOffice("docx");
  external.files["_rels/.rels"] = external.rels(
    external.edge("main", "officeDocument", "https://must-not-fetch.invalid/", true),
  );
  await expect(extractMaterialText("external.docx", external.bytes())).rejects.toMatchObject({ code: "unreadable" });
  const entity = materialOffice("docx");
  entity.files["document/main.xml"] =
    `<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${entity.ns}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`;
  await expect(extractMaterialText("entity.docx", entity.bytes())).rejects.toMatchObject({ code: "unreadable" });
  const expanded = materialOffice("xlsx");
  expanded.files["document/strings.xml"] = `<sst xmlns="${expanded.ns}"><si><t>${"x".repeat(600000)}</t></si></sst>`;
  expanded.files["document/sheet.xml"] =
    `<worksheet xmlns="${expanded.ns}"><sheetData><row r="1">${Array.from({ length: 10 }, (_, i) => `<c r="${String.fromCharCode(65 + i)}1" t="s"><v>0</v></c>`).join("")}</row></sheetData></worksheet>`;
  await expect(extractMaterialText("expanded.xlsx", expanded.bytes())).rejects.toMatchObject({ code: "tooLarge" });
  const empty = materialOffice("xlsx");
  empty.files["document/sheet.xml"] = `<worksheet xmlns="${empty.ns}"><sheetData/></worksheet>`;
  await expect(extractMaterialText("empty.xlsx", empty.bytes())).rejects.toMatchObject({ code: "empty" });
});
test("worker parsing coalesces identical bytes, bounds concurrency, times out and closes without retaining slots", async () => {
  const pool = new MaterialTextWorkers(1),
    timeout = new MaterialTextWorkers(1, 1);
  try {
    const first = pool.read("first.pdf", textPdf({ chinese: true }));
    const second = pool.read("same.pdf", textPdf({ chinese: true }));
    await expect(pool.read("other.pdf", textPdf())).rejects.toMatchObject({ code: "busy" });
    expect(await first).toEqual(await second);
    expect((await pool.read("first.pdf", textPdf({ chinese: true }))).text).toBe("需求文档");
    await expect(timeout.read("slow.pdf", textPdf())).rejects.toMatchObject({ code: "tooLarge" });
    await expect(timeout.read("next.pdf", textPdf())).rejects.toMatchObject({ code: "tooLarge" });
  } finally {
    await Promise.all([pool.close(), timeout.close()]);
  }
  await expect(pool.read("closed.pdf", textPdf())).rejects.toMatchObject({ code: "busy" });
});
test("vendored PDF parser matches the pinned source and retained upstream license inventory", async () => {
  const root = new URL("../../", import.meta.url),
    provenance = JSON.parse(await readFile(new URL("src/server/materials/vendor/provenance.json", root), "utf8")),
    bytes = await readFile(new URL("src/server/materials/vendor/pdf-parser.mjs", root));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(provenance.sha256);
  for (const file of provenance.licenses) expect((await readFile(new URL(file, root))).length).toBeGreaterThan(100);
});
