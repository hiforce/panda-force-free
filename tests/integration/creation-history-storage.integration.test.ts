import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { CreationQueue } from "../../src/server/creation/storage/queue.js";
import { createMySQLCreationStorage } from "../../src/server/creation/storage/mysql.js";
import { consolidateCreationSnapshots, importCreationSQLite } from "../../src/server/creation/storage/mysql-import.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";

for (const backend of ["sqlite", "mysql"] as const)
  test.skipIf(backend === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${backend} history groups rounds before the record limit and clearing retains task receipts`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "creation-history-store-")),
        db = openCreationDatabase(join(root, "creation.sqlite")),
        mysql = backend === "mysql" ? await isolatedMySQLDatabase("history") : null;
      try {
        if (mysql)
          await new DatabaseRegistry()
            .register(mysqlDataMigrationModule)
            .register(mysqlCreationModule)
            .upgrade(new MySQLSchemaConnection(mysql.sql));
        const sqliteTasks = new CreationTaskRepository(db),
          sqliteQueue = new CreationQueue(db, sqliteTasks),
          store = mysql
            ? createMySQLCreationStorage(mysql.sql, "application")
            : { tasks: sqliteTasks, queue: sqliteQueue };
        const create = async (documentId: string, at: number) => {
          const id = randomUUID(),
            spec: CreationTaskSpec = {
              schema: 1,
              id,
              owner: "owner",
              projectId: "project",
              operationId: randomUUID(),
              kind: "document",
              inputDigest: "a".repeat(64),
              skillCaptureId: null,
              target: {
                treeVersion: 0,
                parentId: null,
                locale: "en",
                document: { documentId, revisionId: randomUUID(), version: 1, contentHash: "b".repeat(64) },
              },
            };
          await store.tasks.create(spec, at);
          const lease = await store.tasks.claim("owner", id, at + 1, 30000),
            scope = { ...lease, sessionId: randomUUID(), runId: randomUUID() };
          await store.tasks.bind(lease, scope.sessionId, scope.runId, at + 2);
          await store.tasks.admit(scope, "c".repeat(64), at + 3);
          await store.tasks.complete(
            "owner",
            id,
            "c".repeat(64),
            {
              kind: "document",
              projectId: "project",
              documentId,
              operationId: spec.operationId,
              treeVersion: 1,
              revisionId: randomUUID(),
              revision: 2,
            },
            at + 4,
          );
          return id;
        };
        const other = await create(randomUUID(), 100),
          documentId = randomUUID();
        let last = "";
        for (let index = 0; index < 55; index++) last = await create(documentId, 200 + index * 10);
        expect((await store.queue.list("owner")).map((t) => t.spec.id)).toEqual([last, other]);
        const request = { id: randomUUID(), taskId: last },
          cleared = await store.queue.clearHistory("owner", request, 1000);
        expect(cleared.hidden).toBe(55);
        expect((await store.queue.list("owner")).map((t) => t.spec.id)).toEqual([other]);
        expect((await store.tasks.get("owner", last)).state).toBe("succeeded");
        expect(await store.queue.clearHistory("owner", request, 1001)).toEqual(cleared);
        await expect(Promise.resolve().then(() => store.queue.clearHistory("other", request, 1002))).rejects.toThrow(
          "notFound",
        );
        await expect(
          Promise.resolve().then(() => store.queue.clearHistory("owner", { ...request, taskId: other }, 1003)),
        ).rejects.toThrow("conflict");
        const later = await create(randomUUID(), 2000),
          cutoff = { id: randomUUID(), before: 1001 };
        expect((await store.queue.clearHistory("owner", cutoff, 2100)).hidden).toBe(1);
        expect((await store.queue.list("owner")).map((task) => task.spec.id)).toEqual([later]);
        expect((await store.queue.clearHistory("owner", cutoff, 2200)).hidden).toBe(1);
        if (mysql) {
          const own = createMySQLCreationStorage(mysql.sql, "personal:history-fixture");
          expect(await own.queue.list("owner")).toEqual([]);
          expect((await own.queue.clearHistory("owner", { id: request.id }, 1004)).hidden).toBe(0);
          // Import the SQLite metadata separately to prove clear preferences and action receipts survive cutover.
          const source = randomUUID(),
            s: CreationTaskSpec = {
              schema: 1,
              id: source,
              owner: "owner",
              projectId: "project",
              operationId: randomUUID(),
              kind: "document",
              inputDigest: "d".repeat(64),
              skillCaptureId: null,
              target: { treeVersion: 0, parentId: null, locale: "en" },
            };
          sqliteTasks.create(s, 100);
          const action = { id: randomUUID() };
          const result = sqliteQueue.clearHistory("owner", action, 200);
          db.exec("PRAGMA wal_checkpoint(FULL)");
          const snapshot = join(root, "snapshot.sqlite");
          consolidateCreationSnapshots(snapshot, [
            { namespace: "snapshot-history", snapshotPath: join(root, "creation.sqlite") },
          ]);
          const migration = await isolatedMySQLDatabase("historyimp");
          try {
            await new DatabaseRegistry()
              .register(mysqlDataMigrationModule)
              .register(mysqlCreationModule)
              .upgrade(new MySQLSchemaConnection(migration.sql));
            await importCreationSQLite({ sql: migration.sql, snapshotPath: snapshot, migrationId: "history-snapshot" });
            const imported = createMySQLCreationStorage(migration.sql, "snapshot-history");
            expect(await imported.queue.list("owner")).toEqual([]);
            expect(await imported.queue.clearHistory("owner", action, 300)).toEqual(result);
            expect((await imported.tasks.get("owner", source)).state).toBe("queued");
          } finally {
            await migration.close();
          }
        }
      } finally {
        db.close();
        await mysql?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    120000,
  );
