import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlSkillWorkspaceModule } from "../../src/server/database/modules/skill-workspace.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { SkillWorkspaceStore } from "../../src/server/skill-workspace/store.js";
import { MySQLSkillWorkspaceStore } from "../../src/server/skill-workspace/mysql-store.js";
import { SkillWorkspaceService } from "../../src/server/skill-workspace/service.js";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { migrateSkillWorkspaceSnapshot } from "../../src/server/skill-workspace/migrate.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "configured skill categories and pins migrate to MySQL with revision checks and request replay",
  async () => {
    const fixture = await isolatedMySQLDatabase("skills"),
      { sql } = fixture,
      root = await mkdtemp(join(tmpdir(), "skills-db-copy-")),
      sourcePath = join(root, "source.sqlite"),
      source = new SkillWorkspaceStore(sourcePath),
      catalog = new TemplateCatalog([]);
    try {
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlSkillWorkspaceModule);
      await registry.upgrade(new MySQLSchemaConnection(sql));
      const category = "custom-" + randomUUID();
      const legacy = new SkillWorkspaceService(source, catalog),
        command = {
          operationId: randomUUID(),
          expectedRevision: 0,
          command: {
            type: "create-category",
            id: category,
            name: { en: "Product research", "zh-CN": "商品研究", "zh-HK": "商品研究", "zh-TW": "商品研究" },
          },
        };
      const original = await legacy.change("owner", command);
      const snapshotPath = join(root, "snapshot.sqlite"),
        reader = new Database(sourcePath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(snapshotPath);
      } finally {
        reader.close();
      }
      await chmod(snapshotPath, 0o400);
      await migrateSkillWorkspaceSnapshot({ sql, snapshotPath, migrationId: "skill-workspace-import-v1" });
      const first = new SkillWorkspaceService(new MySQLSkillWorkspaceStore(sql), catalog),
        second = new SkillWorkspaceService(new MySQLSkillWorkspaceStore(sql), catalog);
      expect(await first.snapshot("owner")).toEqual(original);
      expect((await second.snapshot("other")).revision).toBe(0);
      expect(await second.change("owner", command)).toEqual(original);
      expect((await first.collection("owner", category)).personalRevision).toBe(1);
      const changes = await Promise.allSettled([
        first.change("owner", {
          operationId: randomUUID(),
          expectedRevision: 1,
          command: { type: "rename-category", id: category, name: { en: "Research A", "zh-CN": "研究甲" } },
        }),
        second.change("owner", {
          operationId: randomUUID(),
          expectedRevision: 1,
          command: { type: "rename-category", id: category, name: { en: "Research B", "zh-CN": "研究乙" } },
        }),
      ]);
      expect(changes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter((v) => v.status === "rejected")).toHaveLength(1);
      expect((await first.snapshot("owner")).revision).toBe(2);
      expect(await registry.inspect(new MySQLSchemaConnection(sql))).toEqual([]);
    } finally {
      source.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
