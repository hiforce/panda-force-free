import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";

for (const driver of ["sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${driver} ownership history paging exceeds the UI's hundred-revision limit and retains frozen originals`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "document-transfer-history-")),
        database = driver === "mysql" ? await isolatedMySQLDatabase("movehist") : null;
      if (database)
        await new DatabaseRegistry().register(mysqlDocumentsModule).upgrade(new MySQLSchemaConnection(database.sql));
      const feature = database
        ? createMySQLDocumentFeature({ sql: database.sql, stateRoot: root, allowedRoots: [root], requireProject() {} })
        : createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject() {} });
      try {
        const space = await feature.library.ensure("project", "en"),
          documents = feature.service.documents;
        let current = await documents.create(space.id, "history.md", {
          title: "Original title",
          locale: "en",
          content: "Original 1",
        });
        const originalId = current.revision.id;
        for (let n = 2; n <= 121; n++)
          current = await documents.save(current.document.id, n - 1, {
            title: "Version " + n,
            locale: "en",
            content: "Original " + n,
          });
        const id = current.document.id,
          first = await documents.historyPage(id, 122, 17),
          versions = [...first.revisions];
        await documents.save(id, 121, { title: "Later title", locale: "en", content: "Later user edit" });
        let cursor = first.nextBeforeVersion;
        while (cursor !== null) {
          const page = await documents.historyPage(id, cursor, 17);
          versions.push(...page.revisions);
          cursor = page.nextBeforeVersion;
        }
        expect(versions).toHaveLength(121);
        expect(versions.map((row) => row.number)).toEqual(Array.from({ length: 121 }, (_, i) => 121 - i));
        expect(new Set(versions.map((row) => row.id)).size).toBe(121);
        expect(versions.at(-1)!.id).toBe(originalId);
        expect(await documents.revisions(id)).toHaveLength(100);
        for (const selected of [versions[0]!, versions[60]!, versions.at(-1)!]) {
          const revision = await documents.revision(id, selected.id);
          expect(revision.content).toBe("Original " + selected.number);
          expect(revision.contentHash).toBe(selected.contentHash);
          expect(revision.createdAt).toBe(selected.createdAt);
        }
        expect((await documents.record(id)).revision).toBe(122);
        await expect(Promise.resolve().then(() => documents.historyPage(id, 122, 1001))).rejects.toMatchObject({
          code: "invalidInput",
        });
        await expect(Promise.resolve().then(() => documents.historyPage(id, 124))).rejects.toMatchObject({
          code: "conflict",
        });
      } finally {
        if ("close" in feature) feature.close();
        await database?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
