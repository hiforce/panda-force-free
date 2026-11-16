import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { emptyRichBody, type RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import { richDocumentInput } from "../../src/server/documents/rich-codec.js";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const body = (content: RichDocumentBody["document"]["content"]): RichDocumentBody => ({
  schema: 1,
  format: "richtext",
  document: { type: "doc", content },
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-authoring-test-"));
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (!["project", "other"].includes(id)) throw new DocumentError("notFound", 404);
      },
    });
  let feature = open();
  return {
    root,
    get feature() {
      return feature;
    },
    reopen() {
      feature.close();
      feature = open();
    },
    async close() {
      feature.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("project authoring creates readable rich documents and empty nested folders without engine configuration", async () => {
  const f = await fixture();
  try {
    expect(f.feature.library.overview("project")).toEqual({ library: null, folders: [] });
    expect(f.feature.service.listSpaces("project")).toEqual([]);
    f.feature.library.createFolder("project", "Guides/入门");
    expect(f.feature.library.overview("project").folders.map((folder) => folder.path)).toEqual([
      "Guides",
      "Guides/入门",
    ]);
    const detail = f.feature.library.create("project", { title: "Start here", folder: "Guides/入门", locale: "en" });
    expect(detail.revision.body).toEqual(emptyRichBody());
    expect(detail.engine).toBe("markdown");
    expect(detail.document.path).toStartWith("Guides/入门/");
    expect(f.feature.service.listSpaces("project")).toEqual([]);
    expect(
      f.feature.service.listDocuments(detail.document.spaceId, "Start", 0).documents.map((document) => document.id),
    ).toEqual([detail.document.id]);
    expect(() => f.feature.library.createFolder("missing", "test")).toThrow();
    expect(() => f.feature.library.createFolder("project", "../escape")).toThrow();
  } finally {
    await f.close();
  }
});
test("rich formatting, owned images and immutable histories survive restart independently of Markdown projection", async () => {
  const f = await fixture();
  try {
    const initial = f.feature.library.create("project", { title: "A guide", folder: "", locale: "en" });
    const asset = await f.feature.assets.upload(
      initial.document.id,
      "My figure.png",
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
    const rich = body([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A title", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Underlined", marks: [{ type: "underline" }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("A task")] }] },
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "const value = 1;" }] },
      {
        type: "image",
        attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Original figure", title: asset.name },
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("Column")] },
              { type: "tableHeader", content: [paragraph("Value")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("First")] },
              { type: "tableCell", content: [paragraph("Second")] },
            ],
          },
        ],
      },
    ]);
    const saved = f.feature.service.saveDocument(initial.document.id, {
      revision: 1,
      title: "A guide",
      locale: "en",
      body: rich,
    });
    expect(saved.revision.content).toContain("A title");
    expect(saved.revision.content).toContain(asset.id);
    expect(saved.revision.body).toEqual(richDocumentInput(rich).body);
    const revisionId = saved.revision.id,
      hash = saved.document.contentHash;
    f.reopen();
    const restored = f.feature.service.detail(initial.document.id);
    expect(restored.revision.id).toBe(revisionId);
    expect(restored.document.contentHash).toBe(hash);
    expect(restored.revision.body).toEqual(saved.revision.body);
    expect(f.feature.service.documents.revision(initial.document.id, initial.revision.id).body).toEqual(
      emptyRichBody(),
    );
    expect((await f.feature.assets.content(asset.id)).bytes.length).toBeGreaterThan(10);
    expect(() =>
      f.feature.service.saveDocument(initial.document.id, {
        revision: 2,
        title: "A guide",
        locale: "en",
        content: "lose rich source",
      }),
    ).toThrow("invalidRichBody");
    expect(() =>
      f.feature.service.saveDocument(initial.document.id, {
        revision: 1,
        title: "A guide",
        locale: "en",
        body: emptyRichBody(),
      }),
    ).toThrow("conflict");
  } finally {
    await f.close();
  }
});
test("rich source rejects scripts, unsafe links, foreign images and malformed table structures atomically", async () => {
  const f = await fixture();
  try {
    const first = f.feature.library.create("project", { title: "First", locale: "en" }),
      second = f.feature.library.create("other", { title: "Second", locale: "en" });
    const foreign = await f.feature.assets.upload(
      second.document.id,
      "other.png",
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    const invalid = [
      body([{ type: "script", content: [{ type: "text", text: "alert(1)" }] }]),
      body([
        {
          type: "paragraph",
          content: [{ type: "text", text: "Click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
        },
      ]),
      body([{ type: "image", attrs: { src: "https://example.test/private.png" } }]),
      body([{ type: "image", attrs: { src: "/api/document-assets/content?id=" + foreign.id } }]),
      body([{ type: "paragraph", attrs: { onclick: "alert(1)" }, content: [{ type: "text", text: "A" }] }]),
      body([
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableCell", attrs: { rowspan: 4 }, content: [paragraph("Broken")] }],
            },
          ],
        },
      ]),
    ];
    for (const value of invalid)
      expect(() =>
        f.feature.service.saveDocument(first.document.id, { revision: 1, title: "First", locale: "en", body: value }),
      ).toThrow();
    expect(f.feature.service.detail(first.document.id).document.revision).toBe(1);
    expect(f.feature.service.documents.revisions(first.document.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("logical folder changes, trash and restore preserve content, identity and revision history", async () => {
  const f = await fixture();
  try {
    f.feature.library.createFolder("project", "Notes/Private");
    const doc = f.feature.library.create("project", { title: "Keep this", folder: "Notes/Private", locale: "en" }),
      saved = f.feature.service.saveDocument(doc.document.id, {
        revision: 1,
        title: "Keep this",
        locale: "en",
        body: body([paragraph("Permanent content")]),
      });
    const folder = f.feature.library.overview("project").folders.find((folder) => folder.path === "Notes")!;
    f.feature.library.moveFolder("project", { path: folder.path, next: "Guides", version: folder.version });
    expect(f.feature.service.detail(doc.document.id).document.path).toStartWith("Guides/Private/");
    expect(f.feature.service.detail(doc.document.id).revision).toEqual(saved.revision);
    expect(() =>
      f.feature.library.moveFolder("project", { path: "Guides", next: "Guides/Loop", version: 2 }),
    ).toThrow();
    expect(() => f.feature.library.moveDocument("other", { id: doc.document.id, folder: "", revision: 2 })).toThrow(
      "notFound",
    );
    f.feature.library.trash("project", { id: doc.document.id, revision: 2 });
    expect(() => f.feature.service.detail(doc.document.id)).toThrow("notFound");
    expect(f.feature.service.listDocuments(doc.document.spaceId, "", 0).total).toBe(0);
    f.reopen();
    expect(f.feature.library.trashList("project").map((document) => document.id)).toEqual([doc.document.id]);
    const restored = f.feature.library.restore("project", doc.document.id);
    expect(restored.revision).toEqual(saved.revision);
    expect(restored.document.id).toBe(doc.document.id);
    expect(f.feature.service.documents.revisions(doc.document.id)).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test("the authoring migration preserves existing Markdown revisions and source configurations", async () => {
  const f = await fixture();
  try {
    const space = await f.feature.service.createSpace({
      projectId: "project",
      name: "Legacy",
      code: "legacy",
      engine: "markdown",
      sourceMode: "managed",
      locale: "en",
    });
    const detail = f.feature.service.createDocument({
      spaceId: space.id,
      path: "legacy.md",
      title: "Legacy",
      locale: "en",
      content: "# Untouched\n\nSource text.",
    });
    f.feature.close();
    const path = join(f.root, "data", "documents.sqlite"),
      db = new Database(path);
    db.exec(
      "DROP TABLE document_placement_events; DROP TABLE document_placements; DROP TABLE document_rich_revisions;DROP TABLE document_trash;DROP TABLE document_folders;DROP TABLE project_document_libraries;PRAGMA user_version=4;",
    );
    db.close();
    // Reopening after the explicit close exercises the old schema, without touching a real deployment.
    const migrated = createDocumentFeature({ stateRoot: f.root, allowedRoots: [f.root], requireProject: () => ({}) });
    expect(migrated.service.detail(detail.document.id)).toEqual(detail);
    expect(migrated.persistence.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(migrated.library.create("project", { title: "New", locale: "en" }).revision.body).toEqual(emptyRichBody());
    migrated.close();
    expect((await readFile(path)).length).toBeGreaterThan(100);
  } finally {
    await f.close();
  }
});

// Server normalization must settle once, while unsent editing remains on the acknowledged base.
test("save acknowledgements converge normalized fields without replacing in-flight content or formatting", async () => {
  const { acknowledgeDocumentSave, revisionDraft, isDraftChanged } =
    await import("../../src/client/documents/drafts.js");
  const f = await fixture();
  try {
    const initial = f.feature.library.create("project", { title: "Start", locale: "en" });
    const submitted = { ...revisionDraft(initial), title: "  Clean title  " };
    const saved = f.feature.service.saveDocument(initial.document.id, submitted);
    const settled = acknowledgeDocumentSave(submitted, submitted, saved);
    expect(settled.title).toBe("Clean title");
    expect(settled.revision).toBe(2);
    expect(isDraftChanged(settled, saved)).toBe(false);
    const newer = {
      ...submitted,
      title: "Newer title",
      body: body([paragraph("Unsent content")]),
      content: "Unsent content",
    };
    const kept = acknowledgeDocumentSave(newer, submitted, saved);
    expect(kept.title).toBe("Newer title");
    expect(kept.body).toEqual(newer.body);
    expect(kept.content).toBe("Unsent content");
    expect(kept.revision).toBe(2);
    const formatting = {
      ...submitted,
      body: body([
        { type: "paragraph", content: [{ type: "text", text: "Same Markdown", marks: [{ type: "underline" }] }] },
      ]),
    };
    expect(acknowledgeDocumentSave(formatting, submitted, saved).body).toEqual(formatting.body);
  } finally {
    await f.close();
  }
});
