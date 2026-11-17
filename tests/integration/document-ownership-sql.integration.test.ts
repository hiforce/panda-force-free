import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { DocumentOwnershipRecord } from "../../src/shared/documents/ownership.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

for (const driver of ["sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${driver} ownership metadata hides incoming/moved documents and original images from both restore paths`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "document-ownership-sql-")),
        db = driver === "mysql" ? await isolatedMySQLDatabase("ownsql") : null;
      if (db) await new DatabaseRegistry().register(mysqlDocumentsModule).upgrade(new MySQLSchemaConnection(db.sql));
      const feature = db
        ? createMySQLDocumentFeature({ sql: db.sql, stateRoot: root, allowedRoots: [root], requireProject() {} })
        : createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject() {} });
      try {
        const created = await feature.navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Preserved original",
            locale: "en",
          }),
          id = created.operation.documentId,
          original = await feature.service.detail(id),
          bytes = await sharp({ create: { width: 3, height: 4, channels: 3, background: "#408080" } })
            .png()
            .toBuffer(),
          image = await feature.assets.upload(id, "Original.png", bytes);
        await feature.navigation.trash("owner", {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: created.tree.version,
          documentId: id,
          revision: 1,
        });
        const outgoing: DocumentOwnershipRecord = {
            schema: 1,
            documentId: id,
            rootDocumentId: id,
            lineageId: randomUUID(),
            operationId: randomUUID(),
            manifestHash: "a".repeat(64),
            kind: "outgoing",
            from: { projectId: "project-1" },
            to: { projectId: "project-2" },
          },
          space = original.document.spaceId;
        await feature.ownership.put(space, outgoing, null);
        expect(await feature.ownership.get(space, id)).toEqual(outgoing);
        expect((await feature.navigation.trashPage("project-1")).documents).toHaveLength(0);
        expect(await feature.library.trashList("project-1")).toHaveLength(0);
        const restore = async () =>
          feature.navigation.restore("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: (await feature.navigation.tree("project-1")).version,
            documentId: id,
            toRoot: true,
          });
        await expect(restore()).rejects.toMatchObject({ code: "notFound" });
        await expect(Promise.resolve().then(() => feature.library.restore("project-1", id))).rejects.toMatchObject({
          code: "notFound",
        });
        await expect(feature.assets.content(image.id)).rejects.toMatchObject({ code: "notFound" });
        const incoming: DocumentOwnershipRecord = {
          ...outgoing,
          operationId: randomUUID(),
          kind: "incoming",
          from: outgoing.to,
          to: outgoing.from,
        };
        await feature.ownership.put(space, incoming, outgoing);
        await expect(restore()).rejects.toMatchObject({ code: "notFound" });
        await expect(feature.assets.content(image.id)).rejects.toMatchObject({ code: "notFound" });
        const active: DocumentOwnershipRecord = { ...incoming, kind: "active" };
        await feature.ownership.put(space, active, incoming);
        await restore();
        expect((await feature.navigation.tree("project-1")).nodes).toHaveLength(1);
        expect((await feature.service.detail(id)).revision).toEqual(original.revision);
        expect((await feature.assets.content(image.id)).bytes).toEqual(bytes);
        await expect(
          Promise.resolve().then(() => feature.ownership.put(space, { ...active, lineageId: randomUUID() }, active)),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await feature.ownership.get(space, id)).toEqual(active);
        if (driver === "sqlite")
          expect(
            (feature.persistence as import("bun:sqlite").Database)
              .query<{ user_version: number }, []>("PRAGMA user_version")
              .get()!.user_version,
          ).toBe(6);
      } finally {
        if ("close" in feature) feature.close();
        await db?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
