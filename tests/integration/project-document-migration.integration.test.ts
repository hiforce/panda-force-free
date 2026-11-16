import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDocumentDatabase } from "../../src/server/documents/database.js";
import { SpaceRepository } from "../../src/server/documents/space-repository.js";
import { DocumentRepository } from "../../src/server/documents/document-repository.js";
import { DocumentAssetRepository } from "../../src/server/documents/asset-repository.js";
import { contentHash } from "../../src/server/documents/content-hash.js";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { importLegacyProjectDocuments } from "../../src/server/project-content/migration/import-documents.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectDocumentFiles } from "../../src/server/project-content/document-store.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectGit } from "../../src/server/project-content/git/process.js";

const author = { name: "PandaForce migration", email: "migration@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-legacy-documents-")),
    path = join(root, "legacy.sqlite");
  const db = openDocumentDatabase(path),
    spaces = new SpaceRepository(db),
    documents = new DocumentRepository(db);
  const space = spaces.create(
    {
      projectId: "project-1",
      code: "original",
      name: "Original sources",
      engine: "markdown",
      sourceMode: "managed",
      locale: "zh-CN",
      theme: "default",
    },
    join(root, "unused-source"),
  );
  const original = {
    schema: 1 as const,
    format: "richtext" as const,
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Original structured source", marks: [{ type: "bold" }] }],
        },
      ],
    },
  };
  const one = documents.create(space.id, "old.md", {
    title: "原稿一",
    locale: "zh-CN",
    content: "Exact historical Markdown.\r\n\n",
    body: original,
  });
  const asset = new DocumentAssetRepository(db).create({
    id: randomUUID(),
    documentId: one.document.id,
    name: "original filename.png",
    mime: "image/png",
    digest: "a".repeat(64),
    size: 10,
    width: 1,
    height: 1,
    alt: "Original image",
    createdAt: 1000,
  });
  const resources = [
    {
      source: "images/original filename.png",
      sourcePath: "source/images/original filename.png",
      assetId: asset.id,
      digest: asset.digest,
    },
  ];
  const two = documents.save(
    one.document.id,
    1,
    { title: "原稿二", locale: "zh-CN", content: "Another exact projection.\n", body: original },
    contentHash("", original),
    resources,
  );
  db.query("UPDATE documents SET path=?,updatedAt=? WHERE id=?").run("renamed/guide.md", 987654321, one.document.id);
  const expected = documents.get(one.document.id);
  db.close();
  const owned = await createOwnedProjectDirectory(root, "project-1");
  return {
    root,
    path,
    owned,
    expected,
    first: one.revision,
    second: two.revision,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("legacy import preserves current metadata, every original revision and asset references without changing its backup", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    const originalBytes = await readFile(f.path),
      originalHash = createHash("sha256").update(originalBytes).digest("hex");
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const inventory = source.inventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.revisions).toBe(2);
    const imported = await importLegacyProjectDocuments(source, f.owned, author);
    expect(imported.sourceHash).toBe(originalHash);
    expect(imported.revisions).toBe(2);
    expect(imported.currentAndHistoricalVerified).toBe(true);
    expect(imported.metadataMigrated).toBe(false);
    expect(imported.applicationCutover).toBe(false);
    const store = new ProjectDocumentFiles(f.owned);
    expect(await store.get(f.expected.document.id)).toEqual(f.expected);
    expect(await store.revision(f.expected.document.id, f.first.id)).toEqual(f.first);
    expect(await store.revision(f.expected.document.id, f.second.id)).toEqual(f.second);
    const repeated = await importLegacyProjectDocuments(source, f.owned, author);
    expect(repeated.commit).toBe(imported.commit);
    expect((await projectGit(f.owned.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("3");
    source.close();
    source = undefined;
    expect(await readFile(f.path)).toEqual(originalBytes);
    await unlink(f.path);
    const reopened = new ProjectDocumentFiles(f.owned);
    expect(await reopened.get(f.expected.document.id)).toEqual(f.expected);
    expect(await reopened.revision(f.expected.document.id, f.first.id)).toEqual(f.first);
    expect((await reopened.revisions(f.expected.document.id)).map((row) => row.id)).toEqual([f.second.id, f.first.id]);
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);

test("legacy validation rejects a corrupt later revision before importing any earlier revision", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    const db = new Database(f.path);
    db.query("UPDATE document_revisions SET contentHash=? WHERE id=?").run("f".repeat(64), f.second.id);
    db.close();
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const snapshots = new ProjectGitSnapshots(f.owned),
      before = await snapshots.head();
    await expect(importLegacyProjectDocuments(source, f.owned, author)).rejects.toMatchObject({ code: "invalidFile" });
    expect(await snapshots.head()).toBe(before);
    expect(await snapshots.entries(before)).toEqual([]);
  } finally {
    source?.close();
    await f.close();
  }
});

test("migration requires a standalone backup, preserves project isolation and detects source changes", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    await writeFile(f.path + "-wal", "uncheckpointed data");
    await expect(LegacyProjectDocuments.open(f.path, "project-1")).rejects.toMatchObject({ code: "invalidFile" });
    await unlink(f.path + "-wal");
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const other = await createOwnedProjectDirectory(f.root, "other-project");
    await expect(importLegacyProjectDocuments(source, other, author)).rejects.toMatchObject({ code: "unowned" });
    await writeFile(f.path + "-wal", "a different writer");
    await expect(source.assertSourceUnchanged()).rejects.toMatchObject({ code: "conflict" });
    await unlink(f.path + "-wal");
  } finally {
    source?.close();
    await f.close();
  }
});

test("legacy Markdown remains writable and readable when its serialized file is larger than the source body", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    const db = new Database(f.path),
      content = "\x01".repeat(2 * 1024 * 1024);
    const large = new DocumentRepository(db).create(f.expected.document.spaceId, "large.md", {
      title: "Escaped original",
      locale: "en",
      content,
    });
    db.close();
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const report = await importLegacyProjectDocuments(source, f.owned, author);
    expect(report.revisions).toBe(3);
    expect(report.documents.find((row) => row.document.id === large.document.id)!.encodedBytes).toBeGreaterThan(
      6 * 1024 * 1024,
    );
    const reopened = new ProjectDocumentFiles(f.owned);
    expect((await reopened.get(large.document.id)).revision.content).toBe(content);
    expect((await reopened.revision(large.document.id, large.revision.id)).content).toBe(content);
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);
