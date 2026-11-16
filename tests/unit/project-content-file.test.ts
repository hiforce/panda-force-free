import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DocumentDetail } from "../../src/shared/documents/contracts.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { documentContentIdentity } from "../../src/shared/documents/content-identity.js";
import { encodeProjectDocument, decodeProjectDocument } from "../../src/server/project-content/document-file.js";

function source(rich = false): DocumentDetail {
  const body: DocumentDetail["revision"]["body"] = rich
    ? {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "A rich original", marks: [{ type: "bold" }] }] },
          ],
        },
      }
    : undefined;
  const content = "An exact historical projection.\r\n\n",
    hash = createHash("sha256").update(documentContentIdentity(content, body)).digest("hex");
  return {
    document: {
      id: "doc-1",
      spaceId: "space-1",
      path: "guide/文档.md",
      title: "A title",
      locale: "zh-CN",
      revision: 3,
      revisionId: "revision-3",
      contentHash: hash,
      importedHash: "a".repeat(64),
      importedRevision: 1,
      updatedAt: 123456,
    },
    revision: {
      id: "revision-3",
      documentId: "doc-1",
      number: 3,
      title: "A title",
      locale: "zh-CN",
      content,
      ...(body ? { body } : {}),
      contentHash: hash,
      createdAt: 123456,
      resources: [
        {
          source: "images/original.png",
          sourcePath: "blog/images/original.png",
          assetId: "asset-1",
          digest: "b".repeat(64),
        },
      ],
    },
  };
}

test("portable project files retain exact Markdown and structured originals without regenerating old projections", () => {
  for (const rich of [false, true]) {
    const original = source(rich),
      serialized = encodeProjectDocument(original),
      restored = decodeProjectDocument(Buffer.from(serialized));
    expect(restored).toEqual(original);
    expect(encodeProjectDocument(restored)).toBe(serialized);
    expect(restored.revision.content).toBe("An exact historical projection.\r\n\n");
    expect(restored.revision.resources?.[0]?.source).toBe("images/original.png");
  }
});

test("file decoding rejects inconsistent identities, checksums, unknown schemas and invalid UTF-8", () => {
  const valid = JSON.parse(encodeProjectDocument(source()));
  for (const change of [
    (v: typeof valid) => {
      v.revision.content += "unexpected";
    },
    (v: typeof valid) => {
      v.document.revision = 4;
    },
    (v: typeof valid) => {
      v.document.id = "other";
    },
    (v: typeof valid) => {
      v.document.importedRevision = 4;
    },
    (v: typeof valid) => {
      v.revision.resources.push(v.revision.resources[0]);
    },
    (v: typeof valid) => {
      v.attachmentBytes = "not allowed";
    },
  ]) {
    const value = structuredClone(valid);
    change(value);
    expect(() => decodeProjectDocument(JSON.stringify(value))).toThrow();
  }
  expect(() => decodeProjectDocument(JSON.stringify({ ...valid, schema: 2 }))).toThrow("unsupportedSchema");
  expect(() => decodeProjectDocument(new Uint8Array([0xff, 0xfe]))).toThrow("invalidFile");
});

test("content filenames are identity based while user source paths and attachment references remain metadata", () => {
  expect(projectDocumentFile("doc-1")).toBe("documents/doc-1.panda.json");
  for (const id of ["../other", "a/b", "a\\b", ".git", "x:y", "", "x".repeat(129)])
    expect(() => projectDocumentFile(id)).toThrow("invalidFile");
  const input = source();
  input.document.path = "../escape.md";
  expect(() => encodeProjectDocument(input)).toThrow("invalidFile");
});

test("portable files retain a legacy-sized Markdown body even when JSON escaping expands its representation", () => {
  const original = source();
  original.revision.content = "\x01".repeat(2 * 1024 * 1024);
  const hash = createHash("sha256").update(original.revision.content).digest("hex");
  original.document.contentHash = original.revision.contentHash = hash;
  const encoded = encodeProjectDocument(original);
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(6 * 1024 * 1024);
  expect(decodeProjectDocument(encoded)).toEqual(original);
});
