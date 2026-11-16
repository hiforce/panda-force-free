import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlSettingsModule } from "../../src/server/database/modules/settings.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { ProjectVisibilityStore } from "../../src/server/misc/project-visibility.js";
import { MySQLProjectVisibilityStore } from "../../src/server/misc/mysql-project-visibility.js";
import { captureVisibilitySnapshot, migrateSettingsSnapshot } from "../../src/server/misc/visibility-migration.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "visibility preferences migrate from their selected file and MySQL preserves distinct paths and stale-undo fences",
  async () => {
    const f = await isolatedMySQLDatabase("settings"),
      root = await mkdtemp(join(tmpdir(), "settings-mysql-")),
      path = join(root, "visibility.json"),
      source = new ProjectVisibilityStore(path, "/home/fixture");
    try {
      const futurePath = join(root, "future-preferences.json"),
        future = JSON.stringify({
          revision: 1,
          hiddenProjects: { "/future": { hiddenAt: 1, reason: "Preserve future data" } },
        });
      await writeFile(futurePath, future, { mode: 0o600 });
      await expect(captureVisibilitySnapshot({ directory: root, path: futurePath })).rejects.toThrow(
        "Invalid hidden project",
      );
      expect((await readFile(futurePath)).toString()).toBe(future);
      source.setHidden("~/alpha", true);
      source.setHidden("/other/alpha", true);
      source.setHidden("project:managed-project", true);
      const original = await readFile(path),
        snapshotPath = await captureVisibilitySnapshot({ directory: root, path }),
        registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlSettingsModule);
      await registry.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateSettingsSnapshot({ sql: f.sql, snapshotPath, migrationId: "settings-v1" });
      const first = new MySQLProjectVisibilityStore(f.sql, "/home/fixture"),
        second = new MySQLProjectVisibilityStore(f.sql, "/home/fixture"),
        before = await first.snapshot(),
        version = before.hiddenProjects["/home/fixture/alpha"]!.hiddenAt;
      expect(before).toEqual(source.snapshot());
      expect(await first.setHidden("~/alpha", true)).toBe(false);
      expect(await second.setHidden("~/alpha", false, version)).toBe(true);
      expect(await first.setHidden("~/alpha", true)).toBe(true);
      expect(await second.setHidden("~/alpha", false, version)).toBe(false);
      const state = await first.snapshot();
      expect(state.hiddenProjects["/home/fixture/alpha"]!.hiddenAt).toBeGreaterThan(version);
      expect(state.hiddenProjects["/other/alpha"]).toEqual(before.hiddenProjects["/other/alpha"]);
      delete state.hiddenProjects["/other/alpha"];
      expect((await second.snapshot()).hiddenProjects["/other/alpha"]).toBeDefined();
      const concurrent = await Promise.all([first.setHidden("/same-path", true), second.setHidden("/same-path", true)]);
      expect(concurrent.filter(Boolean)).toHaveLength(1);
      expect((await first.snapshot()).hiddenProjects["project:managed-project"]).toEqual(
        before.hiddenProjects["project:managed-project"],
      );
      expect(await readFile(path)).toEqual(original);
      expect(await registry.inspect(new MySQLSchemaConnection(f.sql))).toEqual([]);
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
