import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DocumentOwnershipRecord } from "../../src/shared/documents/ownership.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlModelModule, type MySQLModel } from "../../src/server/database/mysql-model.js";
import modelsV1 from "../../src/server/database/modules/documents-models-v1.json";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { importDocumentsSQLite } from "../../src/server/documents/mysql-import.js";
import { importDocumentOwnershipSQLite } from "../../src/server/documents/ownership/mysql-migration.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "document schema v2 and ownership import preserve shipped v1 receipts and refuse to silently discard ownership",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "document-ownership-migration-")),
      database = await isolatedMySQLDatabase("ownmigrate"),
      source = createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject() {} });
    try {
      const created = source.navigation.create("owner", {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          title: "Immutable source",
          locale: "en",
        }),
        id = created.operation.documentId,
        detail = source.service.documents.get(id),
        record: DocumentOwnershipRecord = {
          schema: 1,
          documentId: id,
          rootDocumentId: id,
          lineageId: randomUUID(),
          operationId: randomUUID(),
          manifestHash: "a".repeat(64),
          kind: "outgoing",
          from: { projectId: "project-1" },
          to: { projectId: "project-2" },
        };
      source.navigation.trash("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: created.tree.version,
        documentId: id,
        revision: 1,
      });
      source.ownership.put(detail.document.spaceId, record, null);
      const path = join(root, "frozen.sqlite");
      source.persistence.query("VACUUM INTO ?").run(path);
      const schema = new MySQLSchemaConnection(database.sql),
        v1 = mysqlModelModule("documents", modelsV1 as readonly MySQLModel[], {
          readWrite: true,
          importFrom: ["sqlite"],
        });
      await new DatabaseRegistry().register(mysqlDataMigrationModule).register(v1).upgrade(schema);
      expect(() =>
        importDocumentsSQLite({ sql: database.sql, snapshotPath: path, migrationId: "documents-v1" }),
      ).toThrow("documentOwnershipMigrationRequired");
      await importDocumentsSQLite({
        sql: database.sql,
        snapshotPath: path,
        migrationId: "documents-v1",
        ownershipWillFollow: true,
      });
      const before = await database.sql`SELECT * FROM panda_force_documents ORDER BY id`,
        versions = await database.sql`SELECT * FROM panda_force_document_revisions ORDER BY id`;
      await new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlDocumentsModule).upgrade(schema);
      expect(await mysqlDocumentsModule.inspect(schema)).toEqual([]);
      expect(await database.sql`SELECT * FROM panda_force_documents ORDER BY id`).toEqual(before);
      expect(await database.sql`SELECT * FROM panda_force_document_revisions ORDER BY id`).toEqual(versions);
      await importDocumentOwnershipSQLite({ sql: database.sql, snapshotPath: path, migrationId: "ownership-v1" });
      await importDocumentsSQLite({
        sql: database.sql,
        snapshotPath: path,
        migrationId: "documents-v1",
        ownershipWillFollow: true,
      });
      await importDocumentOwnershipSQLite({ sql: database.sql, snapshotPath: path, migrationId: "ownership-v1" });
      const target = createMySQLDocumentFeature({
        sql: database.sql,
        stateRoot: root,
        allowedRoots: [root],
        requireProject() {},
      });
      expect(await target.ownership.get(detail.document.spaceId, id)).toEqual(record);
      expect((await target.navigation.trashPage("project-1")).documents).toHaveLength(0);
      expect(await target.service.documents.revision(id, detail.revision.id)).toEqual(detail.revision);
      expect(source.persistence.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(6);
    } finally {
      source.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "ownership import accepts an unchanged v6 backup from before ownership metadata existed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "document-ownership-old-backup-")),
      database = await isolatedMySQLDatabase("ownold"),
      source = createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject() {} });
    try {
      source.persistence.exec("DROP TABLE document_ownership_records;DROP TABLE document_ownership_schema");
      const path = join(root, "old-v6.sqlite");
      source.persistence.query("VACUUM INTO ?").run(path);
      await new DatabaseRegistry()
        .register(mysqlDataMigrationModule)
        .register(mysqlDocumentsModule)
        .upgrade(new MySQLSchemaConnection(database.sql));
      await importDocumentsSQLite({ sql: database.sql, snapshotPath: path, migrationId: "old-docs-v1" });
      await importDocumentOwnershipSQLite({ sql: database.sql, snapshotPath: path, migrationId: "old-own-v1" });
      expect(
        Number((await database.sql`SELECT count(*) count FROM panda_force_document_ownership_records`)[0].count),
      ).toBe(0);
      expect(source.persistence.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(6);
    } finally {
      source.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
