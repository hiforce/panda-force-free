import { test, expect } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { migrateHarnessSnapshot } from "../../src/server/harness/storage/migrate.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "Harness metadata migrates without transcript copies, fences concurrent revisions and keeps defaults after reopen",
  async () => {
    const fixture = await isolatedMySQLDatabase("harness"),
      root = await mkdtemp(join(tmpdir(), "panda-harness-mysql-")),
      path = join(root, "source.sqlite");
    const source = new SQLiteHarnessMetadata(path);
    try {
      const schema = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlHarnessModule);
      await schema.upgrade(new MySQLSchemaConnection(fixture.sql));
      await source.transaction(async (tx) => {
        await tx.put(
          {
            id: "sample",
            kind: "conversation",
            owner: "one",
            revision: 1,
            updatedAt: 1,
            data: JSON.stringify({ historyBytes: 900, bindings: [] }),
          },
          null,
        );
      });
      await source.close();
      const snapshot = join(root, "snapshot.sqlite"),
        db = new Database(path, { readonly: true });
      try {
        db.query("VACUUM INTO ?").run(snapshot);
      } finally {
        db.close();
      }
      await chmod(snapshot, 0o400);
      await migrateHarnessSnapshot({ sql: fixture.sql, snapshotPath: snapshot, migrationId: "harness-import" });
      const a = new MySQLHarnessMetadata(fixture.sql),
        b = new MySQLHarnessMetadata(fixture.sql);
      expect(JSON.parse((await a.read("sample"))!.data).historyBytes).toBe(900);
      expect(await a.list("conversation", "two")).toEqual([]);
      const changes = await Promise.allSettled(
        [a, b].map((store) =>
          store.transaction(async (tx) => {
            const row = (await tx.get("sample"))!;
            await Bun.sleep(15);
            await tx.put({ ...row, revision: 2 }, 1);
          }),
        ),
      );
      expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter((result) => result.status === "rejected")).toHaveLength(1);
      const profiles = [
        {
          id: "codex",
          name: "Codex",
          kind: "codex" as const,
          deployment: "local" as const,
          factory: {
            create: async () => {
              throw Error("notUsed");
            },
          },
        },
      ];
      const registry = new HarnessRegistry(a, profiles);
      await registry.initialize();
      const administrator = { owner: "one", administrator: true },
        catalog = await registry.catalog(administrator),
        runtime = catalog.runtimes[0]!;
      await registry.configure(administrator, { ...runtime, name: "Renamed", makeDefault: true });
      const reopened = new HarnessRegistry(b, profiles);
      await reopened.initialize();
      expect((await reopened.catalog(administrator)).runtimes[0]!.name).toBe("Renamed");
      expect(await schema.inspect(new MySQLSchemaConnection(fixture.sql))).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
