import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import type { RichTextEdit } from "../../src/shared/editorial/contracts.js";
import { applyRichTextEdits } from "../../src/shared/editorial/rich-edits.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createEditorialFeature } from "../../src/server/editorial/integration/feature.js";
import { documentEditorialSources } from "../../src/server/editorial/integration/document-source.js";

const rich = (text = "Words  with spaces.  "): RichDocumentBody => ({
  schema: 1,
  format: "richtext",
  document: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "center" },
        content: [{ type: "text", text, marks: [{ type: "bold" }, { type: "underline" }] }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Link  protected", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
        ],
      },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quote  unchanged" }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "const  example = 1;" }] },
    ],
  },
});
const edit = (extra: Partial<RichTextEdit> = {}): RichTextEdit => ({
  id: "change",
  path: [0, 0],
  start: 5,
  end: 7,
  before: "  ",
  after: " ",
  rule: "repeatedSpaces",
  ...extra,
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-editorial-"));
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (id !== "project") throw Error("Forbidden");
      },
    });
  let documents = open();
  const original = documents.library.create("project", { title: "Original", locale: "en" });
  const saved = documents.service.saveDocument(original.document.id, {
    revision: 1,
    title: "Original",
    locale: "en",
    body: rich(),
  });
  const make = () =>
    createEditorialFeature(documents.persistence, documentEditorialSources(documents.service, documents.persistence))
      .service;
  let service = make();
  return {
    saved,
    get documents() {
      return documents;
    },
    get service() {
      return service;
    },
    prepare: (id: string = randomUUID()) =>
      service.prepare("owner", { id, documentId: saved.document.id, revisionId: saved.revision.id, mode: "spacing" }),
    reopen() {
      documents.close();
      documents = open();
      service = make();
    },
    async close() {
      documents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("canonical edits preserve formatting and reject forged, overlapping, duplicate and grapheme-splitting changes", () => {
  const body = rich("👋 é  words");
  const changed = applyRichTextEdits(body, [edit({ start: 5, end: 7 })]);
  expect(changed.document.content![0]!.content![0]!.text).toBe("👋 é words");
  expect(changed.document.content![0]!.attrs).toEqual({ textAlign: "center" });
  expect(changed.document.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }, { type: "underline" }]);
  expect(body.document.content![0]!.content![0]!.text).toBe("👋 é  words");
  expect(() => applyRichTextEdits(body, [edit({ start: 0, end: 1, before: "\ud83d", after: "x" })])).toThrow(
    "sourceMismatch",
  );
  expect(() => applyRichTextEdits(body, [edit({ start: 3, end: 4, before: "e", after: "x" })])).toThrow(
    "sourceMismatch",
  );
  expect(() => applyRichTextEdits(body, [edit({ before: "forged" })])).toThrow("sourceMismatch");
  expect(() => applyRichTextEdits(body, [edit(), edit()])).toThrow("invalidPatch");
  expect(() =>
    applyRichTextEdits(body, [edit(), edit({ id: "overlap", start: 6, end: 7, before: " ", after: "" })]),
  ).toThrow("overlappingEdits");
  for (const path of [
    [1, 0],
    [2, 0, 0],
    [3, 0],
  ])
    expect(() =>
      applyRichTextEdits(body, [
        edit({ path, start: 0, end: 1, before: path[0] === 1 ? "L" : path[0] === 2 ? "Q" : "c", after: "X" }),
      ]),
    ).toThrow("protectedText");
});

test("empty rich text leaves can be removed after all node paths have been applied without moving other edits", () => {
  const body: RichDocumentBody = {
    schema: 1,
    format: "richtext",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Delete" },
            { type: "text", text: "Keep" },
          ],
        },
      ],
    },
  };
  const result = applyRichTextEdits(body, [
    edit({ path: [0, 0], start: 0, end: 6, before: "Delete", after: "" }),
    edit({ id: "second", path: [0, 1], start: 0, end: 4, before: "Keep", after: "Retain" }),
  ]);
  expect(result.document.content![0]!.content).toEqual([{ type: "text", text: "Retain" }]);
});

test("reviewed selections create one source revision and one durable receipt; retries retain their identity", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare();
    expect(prepared.proposal.edits).toHaveLength(2);
    expect(await f.prepare(prepared.proposal.id)).toEqual(prepared);
    const selected = [prepared.proposal.edits[0]!.id];
    const receipt = await f.service.accept("owner", { id: prepared.proposal.id, digest: prepared.digest, selected });
    const saved = f.documents.service.detail(f.saved.document.id);
    expect(saved.document.revision).toBe(3);
    expect(saved.revision.body!.document.content![0]!.content![0]!.text).toBe("Words with spaces.  ");
    expect(saved.revision.body!.document.content!.slice(1)).toEqual(f.saved.revision.body!.document.content!.slice(1));
    expect(await f.service.accept("owner", { id: prepared.proposal.id, digest: prepared.digest, selected })).toEqual(
      receipt,
    );
    await expect(
      f.service.accept("owner", {
        id: prepared.proposal.id,
        digest: prepared.digest,
        selected: prepared.proposal.edits.map((e) => e.id),
      }),
    ).rejects.toThrow("alreadyApplied");
    f.reopen();
    expect((await f.service.detail("owner", prepared.proposal.id)).receipt).toEqual(receipt);
    expect(await f.service.list("owner", f.saved.document.id)).toHaveLength(1);
    await expect(f.service.detail("another-owner", prepared.proposal.id)).rejects.toThrow("notFound");
    expect(await f.service.accept("owner", { id: prepared.proposal.id, digest: prepared.digest, selected })).toEqual(
      receipt,
    );
    expect(f.documents.service.detail(f.saved.document.id).document.revision).toBe(3);
  } finally {
    await f.close();
  }
});

test("a journal failure rolls back the source commit and allows the same reviewed operation to retry", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(),
      input = { id: prepared.proposal.id, digest: prepared.digest, selected: prepared.proposal.edits.map((e) => e.id) };
    f.documents.persistence.exec(
      "CREATE TRIGGER reject_editorial_receipt BEFORE INSERT ON editorial_applications BEGIN SELECT RAISE(ABORT,'receipt fixture failure'); END",
    );
    await expect(f.service.accept("owner", input)).rejects.toThrow("receipt fixture failure");
    expect(f.documents.service.detail(f.saved.document.id)).toEqual(f.saved);
    expect((await f.service.detail("owner", prepared.proposal.id)).receipt).toBeNull();
    f.documents.persistence.exec("DROP TRIGGER reject_editorial_receipt");
    expect((await f.service.accept("owner", input)).applied.version).toBe(3);
    expect(f.documents.service.detail(f.saved.document.id).revision.body!.document.content![0]!.content![0]!.text).toBe(
      "Words with spaces.",
    );
  } finally {
    await f.close();
  }
});

test("format-only source changes invalidate reviews, unsupported AI modes and invalid selections never mutate a source", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(),
      input = { id: prepared.proposal.id, digest: prepared.digest, selected: prepared.proposal.edits.map((e) => e.id) };
    await expect(f.service.accept("owner", { ...input, selected: [] })).rejects.toThrow("invalidInput");
    await expect(f.service.accept("owner", { ...input, selected: ["forged"] })).rejects.toThrow("invalidInput");
    await expect(
      f.service.prepare("owner", {
        id: randomUUID(),
        documentId: f.saved.document.id,
        revisionId: f.saved.revision.id,
        mode: "proofread",
      }),
    ).rejects.toThrow("unsupportedMode");
    const body = structuredClone(f.saved.revision.body!);
    body.document.content![0]!.attrs = { textAlign: "right" };
    f.documents.service.saveDocument(f.saved.document.id, { revision: 2, title: "Original", locale: "en", body });
    expect((await f.service.detail("owner", prepared.proposal.id)).stale).toBe(true);
    await expect(f.service.accept("owner", input)).rejects.toThrow("staleSource");
    expect((await f.service.detail("owner", prepared.proposal.id)).receipt).toBeNull();
    expect(f.documents.service.detail(f.saved.document.id).document.revision).toBe(3);
  } finally {
    await f.close();
  }
});
