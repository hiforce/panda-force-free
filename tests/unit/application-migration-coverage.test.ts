import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationDatabaseRegistry } from "../../src/server/database/application-registry.js";
import { databaseTableOwnership } from "../../src/server/database/table-ownership.js";
import { applicationMySQLRuntimeBindings } from "../../src/server/database/runtime-stores.js";
import { createLegacySQLiteMigrationSources } from "../../src/server/database/migration/legacy-sources.js";
import { isApplicationMigrationControlTable } from "../../src/server/database/migration/coordinator.js";

test("every application business table has exactly one owned SQLite migration unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-migration-coverage-"));
  try {
    const registry = createApplicationDatabaseRegistry();
    const ownership = databaseTableOwnership(registry);
    const source = await createLegacySQLiteMigrationSources({
      stateRoot: root,
      operationId: "00000000-0000-4000-8000-000000000001",
      current: { schema: 1, driver: "sqlite" },
      target: {
        schema: 1,
        driver: "mysql",
        mysql: {
          hostname: "127.0.0.1",
          port: 3306,
          database: "migration_fixture",
          username: "fixture",
          password: "fixture-password",
          tls: { mode: "verify" },
          max: 2,
          connectionTimeout: 5,
          idleTimeout: 30,
        },
      },
      env: { PANDA_FORCE_HOME: root, CODEX_HOME: join(root, "model"), HOME: join(root, "home") },
    });
    const copied = source.units.flatMap((unit) => unit.targetTables.map((table) => ({ table, module: unit.module })));
    expect(new Set(copied.map((row) => row.table)).size).toBe(copied.length);
    for (const row of copied) expect(ownership.owners.get(row.table)).toBe(row.module);
    for (const [module, tables] of ownership.modules) {
      if (module === "data-migrations") continue;
      expect(applicationMySQLRuntimeBindings).toContain(module);
      for (const table of tables)
        if (!isApplicationMigrationControlTable(table))
          expect(copied.filter((row) => row.module === module && row.table === table)).toHaveLength(1);
    }
    expect(isApplicationMigrationControlTable("panda_force_gadget_workspace_controls")).toBe(true);
    expect(isApplicationMigrationControlTable("panda_force_gadget_workspaces")).toBe(false);
    expect(isApplicationMigrationControlTable("panda_force_gadget_workspace_operations")).toBe(false);
    expect(isApplicationMigrationControlTable("panda_force_unregistered_controls")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
