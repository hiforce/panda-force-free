import { expect, test } from "bun:test";
import { inspectProjectDocument } from "../../src/server/project-content/document-metadata.js";
import { decodeProjectDocument, encodeProjectDocument } from "../../src/server/project-content/document-file.js";
import { boundedFileReadLength } from "../../src/server/project-content/file-reader.js";
import { projectDocumentId } from "../../src/server/project-content/paths.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";

function reader(input: string | Buffer, shortRead = 65536) {
  const bytes = Buffer.from(input),
    reads: { offset: number; length: number; returned: number }[] = [];
  return {
    reads,
    size: bytes.length,
    async read(offset: number, length: number) {
      const result = bytes.subarray(offset, offset + Math.min(length, shortRead));
      reads.push({ offset, length, returned: result.length });
      return result;
    },
  };
}

test("metadata reads a bounded prefix and footer without hydrating a large escaped original", async () => {
  const original = projectDocumentFixture(1, "doc-1", "\x01".repeat(2 * 1024 * 1024));
  const encoded = encodeProjectDocument(original),
    file = reader(encoded),
    metadata = await inspectProjectDocument(file);
  expect(metadata.document).toEqual(original.document);
  expect(metadata.fileBytes).toBe(Buffer.byteLength(encoded));
  expect(metadata.fileBytes).toBeGreaterThan(12 * 1024 * 1024);
  expect(file.reads.reduce((total, read) => total + read.returned, 0)).toBeLessThan(8192);
  expect(file.reads.every((read) => read.offset < 65536 || read.offset >= metadata.fileBytes - 64)).toBe(true);
  expect("revision" in metadata).toBe(false);
  expect(decodeProjectDocument(encoded)).toEqual(original);
});

test("metadata framing respects escaped quotes, braces, Unicode and short positioned reads", async () => {
  const original = projectDocumentFixture();
  original.document.title = original.revision.title = '雪 { quoted "value" } \\ end' + "v".repeat(1950);
  original.document.path = "目录/" + "路".repeat(620) + ".md";
  const encoded = encodeProjectDocument(original);
  expect(Buffer.byteLength(encoded.slice(0, encoded.indexOf('\n  "revision": {')))).toBeGreaterThan(4096);
  for (const maximum of [65536, 7, 1]) {
    const file = reader(encoded, maximum);
    expect(await inspectProjectDocument(file)).toEqual({ document: original.document, fileBytes: file.size });
  }
});

test("metadata is a summary, while full materialization still validates original bytes and checksums", async () => {
  const original = projectDocumentFixture(),
    encoded = encodeProjectDocument(original).replace('"content": "Exact source\\r\\n"', '"content": null');
  expect((await inspectProjectDocument(reader(encoded))).document).toEqual(original.document);
  expect(() => decodeProjectDocument(encoded)).toThrow("invalidFile");
});

test("metadata rejects unknown schemas, invalid records, malformed UTF-8 and oversized headers", async () => {
  const encoded = encodeProjectDocument(projectDocumentFixture());
  const invalid = [
    "",
    encoded.replace('"document": {', '"other": {'),
    encoded.replace('"title": "Document doc-1"', '"title": null'),
    encoded.replace('"schema": 1', '"schema": "1"'),
    encoded.replace('"schema": 1', '"schema": 01'),
    encoded.replace('"schema": 1', '"schema": 1.0'),
    encoded.slice(0, -4),
    '{"document": {' + " ".repeat(65536) + '},"schema":1}',
    Buffer.concat([Buffer.from('{"document":{"title":"'), Buffer.from([0xff]), Buffer.from('"},"schema":1}')]),
  ];
  for (const value of invalid) await expect(inspectProjectDocument(reader(value))).rejects.toThrow("invalidFile");
  await expect(inspectProjectDocument(reader(encoded.replace('"schema": 1', '"schema": 2')))).rejects.toThrow(
    "unsupportedSchema",
  );
});

test("positioned read bounds and metadata identity paths reject invalid inputs", () => {
  expect(boundedFileReadLength(12, 10, 10)).toBe(2);
  expect(boundedFileReadLength(12, 12, 10)).toBe(0);
  expect(boundedFileReadLength(12, 20, 0)).toBe(0);
  for (const [offset, length] of [
    [-1, 1],
    [0, 65537],
    [1.5, 1],
    [0, NaN],
    [Infinity, 1],
  ])
    expect(() => boundedFileReadLength(12, offset!, length!)).toThrow("invalidFile");
  expect(projectDocumentId("documents/doc-1.panda.json")).toBe("doc-1");
  expect(projectDocumentId("spaces/space-1.panda.json")).toBeNull();
  for (const input of ["documents/../escape.panda.json", "documents/.panda.json", null, 12])
    expect(() => projectDocumentId(input)).toThrow("invalidFile");
});
