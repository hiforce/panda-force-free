import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { openDocumentDatabase } from "../../src/server/documents/database.js";
import { SpaceRepository } from "../../src/server/documents/space-repository.js";
import { DocumentRepository } from "../../src/server/documents/document-repository.js";
import { DocumentAssetRepository } from "../../src/server/documents/asset-repository.js";
import { DocumentPlacementRepository } from "../../src/server/documents/placements/repository.js";
import { DocumentNavigationRepository } from "../../src/server/documents/navigation/repository.js";
import { insertRevisionResources } from "../../src/server/documents/revision-resources.js";
import { createMySQLDocumentStorage } from "../../src/server/documents/mysql-storage.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { importDocumentsSQLite } from "../../src/server/documents/mysql-import.js";
const enabled = !!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
const input = (projectId = "project-1", code = "space") => ({
  projectId,
  code,
  name: "Documents",
  engine: "markdown" as const,
  theme: "default",
  sourceMode: "managed" as const,
  locale: "en",
});
test.skipIf(!enabled)(
  "document MySQL snapshot import retains immutable bodies, bindings, navigation receipts and active placement keys",
  async () => {
    const f = await isolatedMySQLDatabase("documents"),
      root = await mkdtemp(join(tmpdir(), "documents-mysql-")),
      source = openDocumentDatabase(join(root, "source.sqlite"));
    try {
      const spaces = new SpaceRepository(source),
        docs = new DocumentRepository(source),
        assets = new DocumentAssetRepository(source),
        placements = new DocumentPlacementRepository(source),
        navigation = new DocumentNavigationRepository(source),
        space = spaces.create(input(), "/unchanged/source"),
        target = spaces.create(input("project-1", "published"), "/unchanged/published"),
        original = docs.create(space.id, "draft.md", { title: "Original", locale: "en", content: "Immutable source" }),
        asset = assets.create({
          id: randomUUID(),
          documentId: original.document.id,
          name: "image.png",
          mime: "image/png",
          digest: "a".repeat(64),
          size: 123,
          width: 20,
          height: 10,
          alt: "Alt",
          createdAt: 1000,
        });
      insertRevisionResources(source, original.document.id, original.revision.id, [
        { source: "image.png", sourcePath: "source/image.png", assetId: asset.id, digest: asset.digest },
      ]);
      const second = docs.save(original.document.id, 1, { title: "Second", locale: "en", content: "Updated source" }),
        operationId = randomUUID();
      navigation.initialize(space.id, [{ documentId: original.document.id, parentId: null, position: 0 }]);
      const receipt = {
        id: operationId,
        documentId: original.document.id,
        affectedDocumentIds: [original.document.id],
        treeVersion: 1,
        restoredToRoot: false,
      };
      navigation.recordOperation(space.id, "owner", operationId, "request", original.document.id, receipt);
      const placement = placements.insert(
        {
          id: randomUUID(),
          projectId: "project-1",
          documentId: original.document.id,
          spaceId: target.id,
          path: "Article.md",
          locale: "en",
          revisionId: original.revision.id,
          metadata: {},
          version: 1,
          createdAt: 1000,
          updatedAt: 1000,
          deletedAt: null,
        },
        "owner",
      );
      const snapshotPath = join(root, "snapshot.sqlite");
      source.query("VACUUM INTO ?").run(snapshotPath);
      await writeFile(join(root, asset.digest), "Existing binary");
      const schema = new MySQLSchemaConnection(f.sql);
      await new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlDocumentsModule).upgrade(schema);
      await importDocumentsSQLite({ sql: f.sql, snapshotPath, migrationId: "documents-v1" });
      await importDocumentsSQLite({ sql: f.sql, snapshotPath, migrationId: "documents-v1" });
      expect(await mysqlDocumentsModule.inspect(schema)).toEqual([]);
      const first = createMySQLDocumentStorage(f.sql),
        other = createMySQLDocumentStorage(f.sql);
      expect(await first.documents.get(original.document.id)).toEqual(docs.get(original.document.id));
      expect(await first.documents.revision(original.document.id, original.revision.id)).toEqual(
        docs.revision(original.document.id, original.revision.id),
      );
      expect(await first.assets.get(asset.id)).toEqual(asset);
      expect(await first.navigation.receipt(space.id, "owner", operationId, "request")).toEqual(receipt);
      await expect(first.navigation.receipt(space.id, "other", operationId, "request")).rejects.toMatchObject({
        status: 404,
      });
      const competing = await Promise.allSettled([
        first.documents.save(original.document.id, 2, { title: "A", locale: "en", content: "A" }),
        other.documents.save(original.document.id, 2, { title: "B", locale: "en", content: "B" }),
      ]);
      expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await first.documents.revisions(original.document.id)).length).toBe(3);
      expect((await first.documents.revision(original.document.id, second.revision.id)).content).toBe("Updated source");
      const removed = await first.placements.remove(placement.id, 1, "owner");
      expect(removed.version).toBe(2);
      const [keys] =
        await f.sql`SELECT activePathHash,activeLocale FROM panda_force_document_placements WHERE id=${placement.id}`;
      expect(keys).toMatchObject({ activePathHash: null, activeLocale: null });
      const replacement = { ...placement, id: randomUUID(), path: "article.md" };
      await first.placements.insert(replacement, "owner");
      const conflicts = await Promise.allSettled([
        first.placements.insert({ ...placement, id: randomUUID(), path: "x.md", locale: "fr" }, "owner"),
        other.placements.insert({ ...placement, id: randomUUID(), path: "X.md", locale: "de" }, "owner"),
      ]);
      expect(conflicts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await readFile(join(root, asset.digest), "utf8")).toBe("Existing binary");
      await first.folders.moveDocument(original.document.id, "folder/renamed.md", 3);
      expect((await first.documents.record(original.document.id)).path).toBe("folder/renamed.md");
      let permitted = true;
      const feature = createMySQLDocumentFeature({
        sql: f.sql,
        stateRoot: root,
        allowedRoots: [],
        requireProject(id) {
          if (id !== "project-1" || !permitted) throw new DocumentError("notFound", 404);
        },
      });
      const command = {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Native async document",
        locale: "en",
      };
      const created = await feature.navigation.create("owner", command),
        replayed = await feature.navigation.create("owner", command);
      expect(replayed).toEqual(created);
      expect(created.tree.nodes).toHaveLength(1);
      const native = created.tree.nodes[0]!.document,
        library = (await feature.library.get("project-1"))!;
      const captured = await feature.snapshots.capture(library.id, "en", { documents: 10, bytes: 65536 });
      expect(captured.documents[0]!.document.id).toBe(native.id);
      const trashed = await feature.navigation.trash("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: created.tree.version,
        documentId: native.id,
        revision: 1,
      });
      expect(trashed.tree.nodes).toHaveLength(0);
      expect((await feature.navigation.trashPage("project-1")).documents).toHaveLength(1);
      const restored = await feature.navigation.restore("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: trashed.tree.version,
        documentId: native.id,
      });
      expect(restored.tree.nodes).toHaveLength(1);
      permitted = false;
      await expect(feature.service.detail(native.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
