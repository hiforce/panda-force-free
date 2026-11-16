import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlGadgetModule } from "../../src/server/database/modules/gadgets.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { GadgetStore } from "../../src/server/gadget/store.js";
import { MySQLGadgetStore } from "../../src/server/gadget/mysql-store.js";
import { GadgetWorkspaceService } from "../../src/server/gadget/service.js";
import { GadgetRegistry } from "../../src/server/gadget/registry.js";
import { registerSystemGadgets } from "../../src/gadget/system/server.js";
import { migrateGadgetSnapshot } from "../../src/server/gadget/migrate.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "gadget layouts migrate with receipts, private owners, concurrent revisions and registered MySQL indexes",
  async () => {
    const fixture = await isolatedMySQLDatabase("gadgets"),
      root = await mkdtemp(join(tmpdir(), "gadget-copy-")),
      path = join(root, "source.sqlite"),
      store = new GadgetStore(path),
      registry = new GadgetRegistry();
    registerSystemGadgets(registry, {
      authorize: () => true,
      sessions: async () => [],
      attention: async () => [],
      projects: async () => [],
      skills: async () => [],
      bots: async () => ({ counts: {} }),
    });
    try {
      const ddl = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlGadgetModule);
      await ddl.upgrade(new MySQLSchemaConnection(fixture.sql));
      await ddl.upgrade(new MySQLSchemaConnection(fixture.sql));
      const source = new GadgetWorkspaceService(registry, store),
        layout = await source.layout("owner");
      layout.items[0]!.title = "My creation";
      const request = { operationId: randomUUID(), layout };
      const original = await source.save("owner", request, '"0"');
      const snapshot = join(root, "snapshot.sqlite"),
        db = new Database(path, { readonly: true });
      try {
        db.query("VACUUM INTO ?").run(snapshot);
      } finally {
        db.close();
      }
      await chmod(snapshot, 0o400);
      await migrateGadgetSnapshot({ sql: fixture.sql, snapshotPath: snapshot, migrationId: "gadget-import-1" });
      const a = new GadgetWorkspaceService(registry, new MySQLGadgetStore(fixture.sql)),
        b = new GadgetWorkspaceService(registry, new MySQLGadgetStore(fixture.sql));
      expect(await a.layout("owner")).toEqual(original);
      expect((await a.layout("other")).revision).toBe(0);
      expect(await b.save("owner", request, '"0"')).toEqual(original);
      const changes = await Promise.allSettled([
        a.save("owner", { operationId: randomUUID(), layout: { ...original, density: "comfortable" } }, '"1"'),
        b.save("owner", { operationId: randomUUID(), layout: { ...original, preset: "equal" } }, '"1"'),
      ]);
      expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await a.layout("owner")).revision).toBe(2);
      expect(await ddl.inspect(new MySQLSchemaConnection(fixture.sql))).toEqual([]);
    } finally {
      store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
