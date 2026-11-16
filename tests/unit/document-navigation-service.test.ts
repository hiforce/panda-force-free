import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { emptyRichBody, type RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import { contentHash } from "../../src/server/documents/content-hash.js";
import { richDocumentInput } from "../../src/server/documents/rich-codec.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-tree-service-"));
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (!["project", "other"].includes(id)) throw new DocumentError("notFound", 404);
      },
    });
  let feature = open();
  disposers.push(async () => {
    feature.close();
    await rm(root, { recursive: true, force: true });
  });
  const f = {
    root,
    get feature() {
      return feature;
    },
    reopen() {
      feature.close();
      feature = open();
    },
    command(extra: Record<string, unknown> = {}) {
      return {
        id: randomUUID(),
        projectId: "project",
        treeVersion: feature.navigation.tree("project").version,
        ...extra,
      };
    },
    create(title: string, parentId: string | null = null) {
      return feature.navigation.create("owner", f.command({ title, parentId })).operation.documentId;
    },
  };
  return f;
}
const rich: RichDocumentBody = {
  schema: 1,
  format: "richtext",
  document: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Keep the source", marks: [{ type: "underline" }] }] },
    ],
  },
};

test("trash keyset pages retain older roots when a newer deletion arrives and reject malformed cursors", async () => {
  const f = await fixture();
  f.feature.library.ensure("project", "en");
  f.feature.persistence
    .transaction(() => {
      for (let i = 0; i < 201; i++) f.feature.library.create("project", { title: "Deleted " + i });
    })
    .immediate();
  const space = f.feature.library.get("project")!;
  f.feature.persistence.query("INSERT INTO document_trash SELECT id,17 FROM documents WHERE spaceId=?").run(space.id);
  const first = f.feature.navigation.trashPage("project");
  expect(first.documents).toHaveLength(200);
  expect(first.nextCursor).not.toBeNull();
  const newest = f.feature.library.create("project", { title: "New deletion" }).document;
  f.feature.persistence.query("INSERT INTO document_trash VALUES(?,999)").run(newest.id);
  const second = f.feature.navigation.trashPage("project", first.nextCursor!);
  expect(second.documents).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.documents, ...second.documents].map((item) => item.document.id)).size).toBe(201);
  expect(second.documents[0]!.document.id).not.toBe(newest.id);
  for (const cursor of [
    "bad!",
    Buffer.from("{}").toString("base64url"),
    Buffer.from('{"deletedAt":-1,"documentId":"x"}').toString("base64url"),
  ])
    expect(() => f.feature.navigation.trashPage("project", cursor)).toThrow("invalidInput");
});

test("empty tree reads are side-effect free; manual and rich creates share stable replay identity across restart", async () => {
  const f = await fixture();
  expect(f.feature.navigation.tree("project")).toEqual({ projectId: "project", version: 0, nodes: [] });
  expect(f.feature.navigation.trashList("project")).toEqual([]);
  expect(existsSync(join(f.root, "data", "spaces"))).toBe(false);
  for (const value of [
    null,
    [],
    {},
    {
      id: randomUUID(),
      projectId: "project",
      treeVersion: 0,
      title: "Invalid",
      body: { document: { type: "script" } },
    },
  ])
    expect(() => f.feature.navigation.create("owner", value)).toThrow();
  expect(f.feature.library.get("project")).toBeNull();
  const input = f.command({ title: "  A document  ", body: rich });
  const created = f.feature.navigation.create("owner", input),
    id = created.operation.documentId;
  expect(created.tree.version).toBe(1);
  expect(f.feature.service.detail(id).revision.body).toEqual(rich);
  const child = f.create("Child", id);
  const replay = f.feature.navigation.create("owner", input);
  expect(replay.operation).toEqual(created.operation);
  expect(replay.tree.nodes).toHaveLength(2);
  expect(replay.tree.version).toBe(2);
  expect(replay.tree.nodes.find((node) => node.documentId === child)!.parentId).toBe(id);
  expect(() => f.feature.navigation.create("another", input)).toThrow("notFound");
  expect(() => f.feature.navigation.create("owner", { ...input, title: "Different" })).toThrow("conflict");
  expect(
    f.feature.persistence.query<{ request: string }, []>("SELECT request FROM document_tree_operations LIMIT 1").get()!
      .request,
  ).toMatch(/^[a-f0-9]{64}$/);
  f.reopen();
  expect(f.feature.navigation.create("owner", input).operation).toEqual(created.operation);
  expect(f.feature.navigation.tree("project").nodes).toHaveLength(2);
  expect(f.feature.service.detail(id).revision.body).toEqual(rich);
  expect(() => f.feature.navigation.tree("missing")).toThrow("notFound");
});

test("legacy folders convert once without hydrating or changing existing rich bodies, images, paths or revisions", async () => {
  const f = await fixture();
  f.feature.library.createFolder("project", "Guides/入门");
  const original = f.feature.library.create("project", { title: "Original", folder: "Guides/入门", locale: "zh-CN" });
  const asset = await f.feature.assets.upload(
    original.document.id,
    "Original image.png",
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
      .png()
      .toBuffer(),
  );
  const withImage = structuredClone(rich);
  withImage.document.content!.push({
    type: "image",
    attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Original" },
  });
  const saved = f.feature.service.saveDocument(original.document.id, {
    title: "Original",
    locale: "zh-CN",
    revision: 1,
    body: withImage,
  });
  const get = f.feature.service.documents.get.bind(f.feature.service.documents);
  f.feature.service.documents.get = (id) => {
    if (id === original.document.id) throw Error("Navigation hydrated a source body");
    return get(id);
  };
  const tree = f.feature.navigation.tree("project");
  f.feature.service.documents.get = get;
  expect(tree.nodes).toHaveLength(3);
  const parent = tree.nodes.find((node) => node.document.title === "入门")!;
  expect(tree.nodes.find((node) => node.documentId === original.document.id)!.parentId).toBe(parent.documentId);
  expect(tree.nodes.find((node) => node.document.title === "Guides")!.parentId).toBeNull();
  expect(f.feature.service.detail(original.document.id)).toEqual(saved);
  expect(f.feature.service.detail(parent.documentId).revision.body).toEqual(emptyRichBody());
  expect(f.feature.navigation.tree("project")).toEqual(tree);
  const late = f.feature.library.create("project", {
    title: "Late legacy creation",
    folder: "Guides/入门",
    locale: "en",
  });
  const next = f.feature.navigation.tree("project");
  expect(next.nodes.find((node) => node.documentId === late.document.id)!.parentId).toBe(parent.documentId);
  expect(next.version).toBe(tree.version + 1);
  f.reopen();
  expect(f.feature.navigation.tree("project")).toEqual(next);
  expect(f.feature.service.detail(original.document.id)).toEqual(saved);
  expect((await f.feature.assets.content(asset.id)).bytes.length).toBeGreaterThan(10);
  expect(f.feature.persistence.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("folder conversion failure rolls back generated documents and can retry without duplicate ancestors", async () => {
  const f = await fixture();
  f.feature.library.createFolder("project", "Guides/Start");
  const original = f.feature.library.create("project", { title: "Original", folder: "Guides/Start" });
  f.feature.persistence.exec(
    "CREATE TRIGGER fail_conversion BEFORE INSERT ON document_tree_nodes BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  expect(() => f.feature.navigation.tree("project")).toThrow("fixture failure");
  expect(f.feature.persistence.query("SELECT id FROM documents").all()).toEqual([{ id: original.document.id }]);
  expect(f.feature.persistence.query("SELECT * FROM document_tree_versions").all()).toEqual([]);
  expect(f.feature.persistence.query("SELECT * FROM document_tree_folder_origins").all()).toEqual([]);
  f.feature.persistence.exec("DROP TRIGGER fail_conversion");
  expect(f.feature.navigation.tree("project").nodes).toHaveLength(3);
  expect(f.feature.navigation.tree("project").nodes).toHaveLength(3);
});

test("moves preserve source identity while rename preserves exact stored projections and fences source revisions", async () => {
  const f = await fixture(),
    a = f.create("A"),
    b = f.create("B"),
    c = f.create("C", a),
    d = f.create("D", c);
  const source = f.feature.service.saveDocument(a, { title: "A", locale: "en", revision: 1, body: rich });
  const input = f.command({ documentId: a, target: { kind: "inside", documentId: b } });
  const moved = f.feature.navigation.move("owner", input);
  expect(moved.operation.affectedDocumentIds).toEqual([a, c, d]);
  expect(f.feature.service.detail(a)).toEqual(source);
  const before = f.feature.navigation.tree("project");
  expect(() =>
    f.feature.navigation.move("owner", f.command({ documentId: b, target: { kind: "inside", documentId: d } })),
  ).toThrow("invalidTreeMove");
  expect(() => f.feature.navigation.move("owner", { ...input, id: randomUUID(), target: { kind: "root" } })).toThrow(
    "navigationConflict",
  );
  const outside = f.feature.navigation.create("owner", {
    id: randomUUID(),
    projectId: "other",
    treeVersion: 0,
    title: "Outside",
  }).operation.documentId;
  expect(() =>
    f.feature.navigation.move("owner", f.command({ documentId: a, target: { kind: "inside", documentId: outside } })),
  ).toThrow("notFound");
  expect(f.feature.navigation.tree("project")).toEqual(before);
  expect(() =>
    f.feature.navigation.rename("owner", f.command({ documentId: a, title: "Renamed", revision: 1 })),
  ).toThrow("conflict");
  const renamed = f.feature.navigation.rename("owner", f.command({ documentId: a, title: "Renamed", revision: 2 }));
  const saved = f.feature.service.detail(a);
  expect(saved.document.path).toBe(source.document.path);
  expect(saved.document.contentHash).toBe(source.document.contentHash);
  expect(saved.revision.content).toBe(source.revision.content);
  expect(saved.revision.body).toEqual(source.revision.body);
  expect(saved.revision.resources).toEqual(source.revision.resources);
  expect(saved.document.revision).toBe(3);
  const replay = f.feature.navigation.move("owner", input);
  expect(replay.operation).toEqual(moved.operation);
  expect(replay.tree).toEqual(renamed.tree);
  expect(() => f.feature.navigation.move("another", input)).toThrow("notFound");
  expect(() => f.feature.navigation.move("owner", { ...input, target: { kind: "root" } })).toThrow("conflict");
});

test("subtree trash and partial restore preserve original revisions; missing parents restore visibly at root", async () => {
  const f = await fixture(),
    a = f.create("A"),
    c = f.create("C", a),
    d = f.create("D", c);
  const original = new Map([a, c, d].map((id) => [id, f.feature.service.detail(id)]));
  const request = f.command({ documentId: a, revision: 1 }),
    deleted = f.feature.navigation.trash("owner", request);
  expect(deleted.tree.nodes).toEqual([]);
  expect(deleted.operation.affectedDocumentIds).toEqual([a, c, d]);
  expect(f.feature.navigation.trash("owner", request).operation).toEqual(deleted.operation);
  expect(f.feature.navigation.trashList("project").map((item) => [item.document.id, item.subtreeCount])).toEqual([
    [a, 3],
  ]);
  expect(() => f.feature.service.detail(c)).toThrow("notFound");
  f.reopen();
  const input = f.command({ documentId: c }),
    restored = f.feature.navigation.restore("owner", input);
  expect(restored.operation.affectedDocumentIds).toEqual([c, d]);
  expect(restored.operation.restoredToRoot).toBe(true);
  expect(restored.tree.nodes.find((node) => node.documentId === c)!.parentId).toBeNull();
  expect(restored.tree.nodes.find((node) => node.documentId === d)!.parentId).toBe(c);
  expect(f.feature.navigation.restore("owner", input).operation).toEqual(restored.operation);
  expect(f.feature.navigation.trashList("project").map((item) => [item.document.id, item.subtreeCount])).toEqual([
    [a, 1],
  ]);
  const final = f.feature.navigation.restore("owner", f.command({ documentId: a }));
  expect(final.operation.affectedDocumentIds).toEqual([a]);
  expect(final.tree.nodes.find((node) => node.documentId === c)!.parentId).toBeNull();
  for (const id of [a, c, d]) expect(f.feature.service.detail(id)).toEqual(original.get(id)!);
  expect(f.feature.persistence.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("restoring a branch respects current depth and can explicitly restore to root without partial writes", async () => {
  const f = await fixture(),
    a = f.create("A"),
    c = f.create("C", a),
    d = f.create("D", c);
  f.feature.navigation.trash("owner", f.command({ documentId: c, revision: 1 }));
  let parent: string | null = null;
  for (let i = 0; i < 31; i++) parent = f.create("Level " + i, parent);
  f.feature.navigation.move("owner", f.command({ documentId: a, target: { kind: "inside", documentId: parent } }));
  const before = f.feature.navigation.tree("project"),
    input = f.command({ documentId: c });
  expect(() => f.feature.navigation.restore("owner", input)).toThrow("treeDepth");
  expect(f.feature.navigation.tree("project")).toEqual(before);
  expect(() => f.feature.service.detail(d)).toThrow("notFound");
  const restored = f.feature.navigation.restore("owner", { ...input, toRoot: true });
  expect(restored.operation.restoredToRoot).toBe(true);
  expect(restored.tree.nodes.find((node) => node.documentId === c)!.parentId).toBeNull();
  expect(restored.tree.nodes.find((node) => node.documentId === d)!.parentId).toBe(c);
});

test("legacy single deletion lifts surviving children; restoring through the legacy API rejoins the canonical tree", async () => {
  const f = await fixture(),
    a = f.create("A"),
    c = f.create("C", a),
    d = f.create("D", c);
  f.feature.library.trash("project", { id: a, revision: 1 });
  const tree = f.feature.navigation.tree("project");
  expect(tree.nodes.map((node) => node.documentId).sort()).toEqual([c, d].sort());
  expect(tree.nodes.find((node) => node.documentId === c)!.parentId).toBeNull();
  f.feature.library.restore("project", a);
  const restored = f.feature.navigation.tree("project");
  expect(restored.nodes).toHaveLength(3);
  expect(restored.nodes.find((node) => node.documentId === c)!.parentId).toBeNull();
  expect(f.feature.navigation.trashList("project")).toEqual([]);
  expect(f.feature.persistence.query("SELECT * FROM document_tree_trash").all()).toEqual([]);
});

test("legacy restore respects an explicitly saved root instead of the document's original disk folder", async () => {
  const f = await fixture();
  const document = f.feature.library.create("project", { title: "Original", folder: "Legacy folder" }).document;
  f.feature.navigation.tree("project");
  f.feature.navigation.move("owner", f.command({ documentId: document.id, target: { kind: "root" } }));
  f.feature.library.trash("project", { id: document.id, revision: 1 });
  f.feature.navigation.tree("project");
  f.feature.library.restore("project", document.id);
  const restored = f.feature.navigation.tree("project");
  expect(restored.nodes.find((node) => node.documentId === document.id)!.parentId).toBeNull();
  expect(f.feature.service.detail(document.id).document.path).toBe(document.path);
});

test("operation journal failures roll back content, topology and trash before a safe retry", async () => {
  const f = await fixture(),
    a = f.create("A"),
    c = f.create("C", a),
    before = f.feature.navigation.tree("project"),
    original = f.feature.service.detail(a);
  f.feature.persistence.exec(
    "CREATE TRIGGER fail_operation BEFORE INSERT ON document_tree_operations WHEN NEW.owner='blocked' BEGIN SELECT RAISE(ABORT,'journal failure'); END",
  );
  const create = f.command({ title: "New" }),
    rename = f.command({ documentId: a, title: "Renamed", revision: 1 }),
    trash = f.command({ documentId: a, revision: 1 });
  expect(() => f.feature.navigation.create("blocked", create)).toThrow("journal failure");
  expect(() => f.feature.navigation.rename("blocked", rename)).toThrow("journal failure");
  expect(() => f.feature.navigation.trash("blocked", trash)).toThrow("journal failure");
  expect(f.feature.navigation.tree("project")).toEqual(before);
  expect(f.feature.service.detail(a)).toEqual(original);
  expect(f.feature.service.detail(c).document.revision).toBe(1);
  expect(f.feature.navigation.trashList("project")).toEqual([]);
  f.feature.persistence.exec("DROP TRIGGER fail_operation");
  const deleted = f.feature.navigation.trash("blocked", trash);
  expect(deleted.operation.affectedDocumentIds).toEqual([a, c]);
  expect(f.feature.navigation.trash("blocked", trash).operation).toEqual(deleted.operation);
  expect(f.feature.persistence.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
});

test("the active document limit excludes trash and rejects oversized restores without losing their recovery records", async () => {
  const f = await fixture(),
    space = f.feature.library.ensure("project", "en"),
    empty = richDocumentInput(emptyRichBody());
  f.feature.navigation.tree("project");
  const db = f.feature.persistence;
  db.transaction(() => {
    db.query(
      `WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<4999)
      INSERT INTO documents SELECT 'bulk-'||n,?,'bulk-'||n||'.md','Bulk '||n,'en',1,'revision-'||n,?,NULL,NULL,1 FROM sequence`,
    ).run(space.id, contentHash(empty.content, empty.body));
    db.query(
      "INSERT INTO document_revisions SELECT revisionId,id,1,title,locale,?,contentHash,1 FROM documents WHERE spaceId=?",
    ).run(empty.content, space.id);
    db.query("INSERT INTO document_rich_revisions SELECT revisionId,? FROM documents WHERE spaceId=?").run(
      JSON.stringify(empty.body),
      space.id,
    );
    db.query(
      "INSERT INTO document_tree_nodes SELECT id,spaceId,NULL,CAST(substr(id,6) AS INTEGER) FROM documents WHERE spaceId=?",
    ).run(space.id);
    db.query("UPDATE document_tree_versions SET version=1 WHERE spaceId=?").run(space.id);
  }).immediate();
  const input = f.command({ title: "One more" });
  expect(() => f.feature.navigation.create("owner", input)).toThrow("tooManyDocuments");
  expect(db.query("SELECT count(*) AS count FROM documents").get()).toEqual({ count: 5000 });
  f.feature.navigation.trash("owner", f.command({ documentId: "bulk-0", revision: 1 }));
  const next = f.feature.navigation.create("owner", f.command({ title: "Replacement" }));
  expect(next.tree.nodes).toHaveLength(5000);
  expect(db.query("SELECT count(*) AS count FROM documents").get()).toEqual({ count: 5001 });
  const restore = f.command({ documentId: "bulk-0" });
  expect(() => f.feature.navigation.restore("owner", restore)).toThrow("tooManyDocuments");
  expect(f.feature.navigation.trashList("project")[0]!.document.id).toBe("bulk-0");
  f.feature.navigation.trash("owner", f.command({ documentId: "bulk-1", revision: 1 }));
  const restored = f.feature.navigation.restore("owner", f.command({ documentId: "bulk-0" }));
  expect(restored.tree.nodes).toHaveLength(5000);
  expect(f.feature.service.detail("bulk-0").revision.body).toEqual(empty.body);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}, 15_000);
