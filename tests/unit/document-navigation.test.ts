import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDocumentDatabase } from "../../src/server/documents/database.js";
import { SpaceRepository } from "../../src/server/documents/space-repository.js";
import { DocumentRepository } from "../../src/server/documents/document-repository.js";
import { DocumentNavigationRepository } from "../../src/server/documents/navigation/repository.js";
import {
  validateDocumentTree,
  moveDocumentTree,
  documentSubtree,
  DOCUMENT_TREE_LIMITS,
  type DocumentTreePlacement,
} from "../../src/shared/documents/navigation.js";

const tree: DocumentTreePlacement[] = [
  { documentId: "a", parentId: null, position: 0 },
  { documentId: "b", parentId: null, position: 1 },
  { documentId: "c", parentId: "a", position: 0 },
  { documentId: "d", parentId: "c", position: 0 },
];
const children = (nodes: DocumentTreePlacement[], parentId: string | null) =>
  nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((node) => node.documentId);

test("every document can contain documents; sibling moves and reparenting preserve descendant identities without paths", () => {
  const original = structuredClone(tree),
    inside = moveDocumentTree(tree, "a", { kind: "inside", documentId: "b" });
  expect(children(inside, null)).toEqual(["b"]);
  expect(children(inside, "b")).toEqual(["a"]);
  expect(children(inside, "a")).toEqual(["c"]);
  expect(children(inside, "c")).toEqual(["d"]);
  expect(documentSubtree(inside, "b")).toEqual(["b", "a", "c", "d"]);
  const before = moveDocumentTree(inside, "c", { kind: "before", documentId: "b" });
  expect(children(before, null)).toEqual(["c", "b"]);
  expect(children(before, "c")).toEqual(["d"]);
  expect(children(moveDocumentTree(before, "c", { kind: "after", documentId: "b" }), null)).toEqual(["b", "c"]);
  const root = moveDocumentTree(inside, "a", { kind: "root" });
  expect(children(root, null)).toEqual(["b", "a"]);
  expect(moveDocumentTree(tree, "a", { kind: "before", documentId: "a" })).toEqual(original);
  expect(tree).toEqual(original);
});

test("tree topology rejects cycles, missing targets, invalid ranks and depth/size overflow before mutation", () => {
  expect(() => moveDocumentTree(tree, "a", { kind: "inside", documentId: "d" })).toThrow("cycle");
  expect(() => moveDocumentTree(tree, "a", { kind: "inside", documentId: "a" })).toThrow("cycle");
  expect(() => moveDocumentTree(tree, "a", { kind: "after", documentId: "d" })).toThrow("cycle");
  expect(() => moveDocumentTree(tree, "missing", { kind: "root" })).toThrow("missing");
  expect(() => moveDocumentTree(tree, "a", { kind: "inside", documentId: "other-project" })).toThrow("missing");
  expect(() => validateDocumentTree([...tree, tree[0]!])).toThrow("invalid");
  expect(() => validateDocumentTree([{ documentId: "a", parentId: "unknown", position: 0 }])).toThrow("invalid");
  for (const position of [-1, NaN, Infinity, 0.5])
    expect(() => validateDocumentTree([{ documentId: "a", parentId: null, position }])).toThrow("invalid");
  const deep = Array.from({ length: DOCUMENT_TREE_LIMITS.depth }, (_, index) => ({
    documentId: String(index),
    parentId: index ? String(index - 1) : null,
    position: 0,
  }));
  expect(() => validateDocumentTree(deep)).not.toThrow();
  expect(() =>
    validateDocumentTree([...deep, { documentId: "too-deep", parentId: deep.at(-1)!.documentId, position: 0 }]),
  ).toThrow("depth");
  expect(() =>
    validateDocumentTree(
      Array.from({ length: DOCUMENT_TREE_LIMITS.documents + 1 }, (_, index) => ({
        documentId: String(index),
        parentId: null,
        position: index,
      })),
    ),
  ).toThrow("limit");
});

test("navigation transactions persist only structure, fence concurrent versions and bind replay to project, owner and request", () => {
  const db = openDocumentDatabase(":memory:"),
    spaces = new SpaceRepository(db),
    documents = new DocumentRepository(db);
  try {
    const space = spaces.create(
      {
        projectId: "project",
        code: "originals",
        name: "Originals",
        engine: "markdown",
        theme: "default",
        sourceMode: "managed",
        locale: "en",
      },
      "/isolated/source",
      randomUUID(),
    );
    const originals = ["A", "B", "C", "D"].map((title) =>
      documents.create(space.id, title + ".md", { title, locale: "en", content: "Original " + title }),
    );
    const assetId = randomUUID(),
      documentId = originals[0]!.document.id;
    db.query("INSERT INTO document_assets VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      assetId,
      documentId,
      "original.png",
      "image/png",
      "fixture-digest",
      12,
      2,
      2,
      "Original asset",
      1,
    );
    documents.save(documentId, 1, {
      title: "A",
      locale: "en",
      content: "An original with an image",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Original", marks: [{ type: "bold" }] }] },
            { type: "image", attrs: { src: "/api/document-assets/content?id=" + assetId } },
          ],
        },
      },
    });
    const content = () =>
      Object.fromEntries(
        ["documents", "document_revisions", "document_rich_revisions", "document_assets"].map((table) => [
          table,
          db.query("SELECT * FROM " + table + " ORDER BY rowid").all(),
        ]),
      );
    const before = content(),
      repository = new DocumentNavigationRepository(db),
      placements = tree.map((node) => ({
        ...node,
        documentId: originals["abcd".indexOf(node.documentId)]!.document.id,
        parentId: node.parentId ? originals["abcd".indexOf(node.parentId)]!.document.id : null,
      }));
    expect(repository.initialize(space.id, placements)).toBe(true);
    expect(repository.initialize(space.id, [])).toBe(false);
    expect(repository.version(space.id)).toBe(1);
    const moved = moveDocumentTree(placements, documentId, { kind: "inside", documentId: originals[1]!.document.id }),
      operation = randomUUID(),
      request = JSON.stringify({ kind: "move", node: documentId, parent: originals[1]!.document.id, version: 1 });
    repository.transaction(() => {
      repository.replace(space.id, moved);
      repository.bump(space.id, 1);
      repository.recordOperation(space.id, "owner", operation, request, documentId);
    });
    expect(repository.version(space.id)).toBe(2);
    expect(repository.operation(space.id, "owner", operation, request)).toBe(documentId);
    expect(() => repository.operation(space.id, "another", operation, request)).toThrow("notFound");
    expect(() => repository.operation("another-project", "owner", operation, request)).toThrow("notFound");
    expect(() => repository.operation(space.id, "owner", operation, request + "different")).toThrow("conflict");
    const committed = repository.rows(space.id);
    expect(() =>
      repository.transaction(() => {
        repository.replace(space.id, placements);
        repository.bump(space.id, 1);
      }),
    ).toThrow("navigationConflict");
    expect(repository.rows(space.id)).toEqual(committed);
    expect(() => repository.replace(space.id, placements.slice(1))).toThrow();
    expect(repository.rows(space.id)).toEqual(committed);
    const reopened = new DocumentNavigationRepository(db);
    expect(reopened.rows(space.id)).toEqual(committed);
    expect(content()).toEqual(before);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.query("UPDATE document_navigation_schema SET version=3 WHERE id=1").run();
    expect(() => new DocumentNavigationRepository(db)).toThrow("unsupportedSchema");
  } finally {
    db.close();
  }
});

test("navigation survives an actual database reopen; a second connection cannot apply a stale move or attach another project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-navigation-")),
    path = join(directory, "documents.sqlite");
  let db = openDocumentDatabase(path);
  try {
    const spaces = new SpaceRepository(db),
      documents = new DocumentRepository(db),
      createSpace = (projectId: string) =>
        spaces.create(
          {
            projectId,
            code: "originals",
            name: "Originals",
            engine: "markdown",
            theme: "default",
            sourceMode: "managed",
            locale: "en",
          },
          "/isolated/" + projectId,
          randomUUID(),
        ),
      first = createSpace("project-a"),
      second = createSpace("project-b"),
      a = documents.create(first.id, "a.md", { title: "Same title", locale: "en", content: "Original A" }).document,
      b = documents.create(first.id, "b.md", { title: "Same title", locale: "en", content: "Original B" }).document,
      outside = documents.create(second.id, "outside.md", {
        title: "Outside",
        locale: "en",
        content: "Another project",
      }).document,
      repository = new DocumentNavigationRepository(db);
    repository.initialize(first.id, [
      { documentId: a.id, parentId: null, position: 0 },
      { documentId: b.id, parentId: null, position: 1 },
    ]);
    repository.initialize(second.id, []);
    expect(() => repository.insert(first.id, { documentId: outside.id, parentId: null, position: 0 })).toThrow(
      "notFound",
    );
    expect(() =>
      repository.transaction(() =>
        repository.insert(second.id, { documentId: outside.id, parentId: a.id, position: 0 }),
      ),
    ).toThrow();
    expect(repository.rows(second.id)).toEqual([]);
    const connection = openDocumentDatabase(path),
      concurrent = new DocumentNavigationRepository(connection);
    try {
      const placements = concurrent
        .rows(first.id)
        .map(({ documentId, parentId, position }) => ({ documentId, parentId, position }));
      concurrent.transaction(() => {
        concurrent.replace(first.id, moveDocumentTree(placements, b.id, { kind: "inside", documentId: a.id }));
        concurrent.bump(first.id, 1);
      });
      expect(() =>
        repository.transaction(() => {
          repository.replace(first.id, placements);
          repository.bump(first.id, 1);
        }),
      ).toThrow("navigationConflict");
      expect(repository.rows(first.id).find((node) => node.documentId === b.id)!.parentId).toBe(a.id);
    } finally {
      connection.close();
    }
    const committed = repository.rows(first.id);
    db.close();
    db = openDocumentDatabase(path);
    const reopened = new DocumentNavigationRepository(db);
    expect(reopened.version(first.id)).toBe(2);
    expect(reopened.rows(first.id)).toEqual(committed);
    expect(new DocumentRepository(db).get(a.id).revision.content).toBe("Original A");
    expect(new DocumentRepository(db).get(b.id).revision.content).toBe("Original B");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the navigation v1 migration preserves source tables and existing journal and trash identities", () => {
  const db = openDocumentDatabase(":memory:"),
    spaces = new SpaceRepository(db),
    documents = new DocumentRepository(db);
  try {
    const space = spaces.create(
      {
        projectId: "project",
        code: "originals",
        name: "Originals",
        engine: "markdown",
        theme: "default",
        sourceMode: "managed",
        locale: "en",
      },
      "/isolated/source",
      randomUUID(),
    );
    const parent = documents.create(space.id, "parent.md", {
      title: "Parent",
      locale: "en",
      content: "Original parent",
    }).document;
    const child = documents.create(space.id, "child.md", {
      title: "Child",
      locale: "en",
      content: "Original child",
    }).document;
    // This fixed fixture is the older on-disk format, not the current migration output.
    db.exec(`CREATE TABLE document_navigation_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      CREATE TABLE document_tree_versions(spaceId TEXT PRIMARY KEY REFERENCES document_spaces(id),version INTEGER NOT NULL CHECK(version>=0));
      CREATE TABLE document_tree_nodes(documentId TEXT PRIMARY KEY REFERENCES documents(id),spaceId TEXT NOT NULL REFERENCES document_spaces(id),parentId TEXT,position INTEGER NOT NULL CHECK(position>=0),UNIQUE(documentId,spaceId),FOREIGN KEY(parentId,spaceId) REFERENCES document_tree_nodes(documentId,spaceId) DEFERRABLE INITIALLY DEFERRED);
      CREATE INDEX document_tree_children ON document_tree_nodes(spaceId,parentId,position,documentId);
      CREATE TABLE document_tree_operations(id TEXT PRIMARY KEY,spaceId TEXT NOT NULL REFERENCES document_spaces(id),owner TEXT NOT NULL,request TEXT NOT NULL,documentId TEXT NOT NULL REFERENCES documents(id),createdAt INTEGER NOT NULL);
      CREATE TABLE document_tree_trash(documentId TEXT PRIMARY KEY REFERENCES document_tree_nodes(documentId),operationId TEXT NOT NULL REFERENCES document_tree_operations(id) DEFERRABLE INITIALLY DEFERRED);
      INSERT INTO document_navigation_schema VALUES(1,1);`);
    const operation = randomUUID();
    db.query("INSERT INTO document_tree_versions VALUES(?,7)").run(space.id);
    db.query("INSERT INTO document_tree_nodes VALUES(?,?,?,?)").run(parent.id, space.id, null, 0);
    db.query("INSERT INTO document_tree_nodes VALUES(?,?,?,?)").run(child.id, space.id, parent.id, 0);
    db.query("INSERT INTO document_tree_operations VALUES(?,?,?,?,?,?)").run(
      operation,
      space.id,
      "owner",
      "old-request",
      child.id,
      123,
    );
    db.query("INSERT INTO document_tree_trash VALUES(?,?)").run(child.id, operation);
    db.query("INSERT INTO document_trash VALUES(?,?)").run(child.id, 123);
    const before = documents.get(child.id),
      revisions = db.query("SELECT * FROM document_revisions ORDER BY id").all();
    const repository = new DocumentNavigationRepository(db);
    expect(repository.version(space.id)).toBe(7);
    expect(repository.tombstone(space.id, child.id)).toEqual({
      documentId: child.id,
      parentId: parent.id,
      position: 0,
      operationId: operation,
    });
    expect(repository.operation(space.id, "owner", operation, "old-request")).toBe(child.id);
    expect(() => repository.receipt(space.id, "owner", operation, "old-request")).toThrow("navigationConflict");
    expect(documents.get(child.id)).toEqual(before);
    expect(db.query("SELECT * FROM document_revisions ORDER BY id").all()).toEqual(revisions);
    expect(db.query("SELECT * FROM document_tree_operations").all()).toEqual([
      {
        id: operation,
        spaceId: space.id,
        owner: "owner",
        request: "old-request",
        documentId: child.id,
        createdAt: 123,
        result: null,
      },
    ]);
    expect(() => new DocumentNavigationRepository(db)).not.toThrow();
    expect(db.query("SELECT version FROM document_navigation_schema").get()).toEqual({ version: 2 });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});
