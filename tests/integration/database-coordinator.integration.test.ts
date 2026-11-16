import { test, expect } from "bun:test";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  DatabaseManagementState,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "../../src/server/database/management/state.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { mysqlModelModule } from "../../src/server/database/mysql-model.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { migrateSQLiteModule } from "../../src/server/database/data-migration.js";
import {
  executeApplicationMigration,
  migrationUnitsFingerprint,
  type ApplicationMigrationUnit,
} from "../../src/server/database/migration/coordinator.js";
import { captureFrozenSQLiteSource } from "../../src/server/database/migration/snapshot.js";
import { assertApplicationDatabaseActivation } from "../../src/server/database/migration/activation.js";
import { readApplicationDatabaseConfig, type ApplicationDatabaseConfig } from "../../src/server/database/config.js";

const fixture = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!fixture)(
  "a fenced migration resumes frozen rows and activates only after verification",
  async () => {
    const c = await Bun.file(fixture!).json();
    if (c.hostname !== "127.0.0.1" || c.database !== "panda_force_test")
      throw Error("Dedicated loopback fixture required");
    const schema = "panda_force_test_coordinator_" + randomUUID().replaceAll("-", ""),
      admin = new SQL({ ...c, adapter: "mysql", max: 2 });
    await admin.unsafe(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const root = await mkdtemp(join(tmpdir(), "pf-coordinator-")),
      state = new DatabaseManagementState(root),
      sql = new SQL({ ...c, database: schema, adapter: "mysql", max: 2 });
    try {
      const sourcePath = join(root, "source.sqlite"),
        source = new Database(sourcePath, { create: true });
      source.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY,body TEXT NOT NULL)");
      source.transaction(() => {
        for (let id = 1; id <= 205; id++) source.query("INSERT INTO fixture VALUES(?,?)").run(id, "文" + id);
      })();
      source.close();
      const config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }> = {
        schema: 1,
        driver: "mysql",
        mysql: {
          hostname: c.hostname,
          port: Number(c.port ?? 3306),
          database: schema,
          username: c.username,
          password: c.password,
          tls: { mode: "disabled" },
          max: 3,
          connectionTimeout: 5,
          idleTimeout: 30,
        },
      };
      const id = randomUUID(),
        planId = randomUUID(),
        now = Date.now(),
        owner = "a".repeat(64);
      const plan: StoredDatabasePlan = {
        schema: 1,
        owner,
        config,
        public: {
          id: planId,
          source: { driver: "sqlite" },
          target: { driver: "mysql", hostname: c.hostname, port: config.mysql.port, database: schema, tls: "disabled" },
          restartRequired: true,
          ready: true,
          modules: [{ module: "fixtures", action: "copy", tableCount: 1 }],
          issues: [],
          expiresAt: now + 60000,
        },
      };
      const operation: StoredDatabaseOperation = {
        schema: 1,
        owner,
        planId,
        statusTokenHash: createHash("sha256").update("test").digest("hex"),
        tokenExpiresAt: now + 60000,
        public: {
          id,
          status: "waiting-restart",
          stage: "restart",
          source: plan.public.source,
          target: plan.public.target,
          modules: [{ module: "fixtures", stage: "pending", rows: 0 }],
          startedAt: now,
          updatedAt: now,
          canRetry: false,
          canCancel: true,
        },
      };
      await state.write("plans", planId, plan);
      await state.write("operations", id, operation);
      await state.write("", "pending", { operationId: id });
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(
        mysqlModelModule(
          "fixtures",
          [
            {
              name: "panda_force_fixture",
              columns: [
                { name: "id", type: "bigint", nullable: false },
                { name: "body", type: "longtext", nullable: false },
              ],
              indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
            },
          ],
          { readWrite: true, importFrom: ["sqlite"] },
        ),
      );
      let interrupt = true,
        captures = 0;
      const units: ApplicationMigrationUnit[] = [
        {
          id: "fixture",
          module: "fixtures",
          source: "fixture",
          targetTables: ["panda_force_fixture"],
          copy: async (options) =>
            migrateSQLiteModule({
              ...options,
              module: "fixtures",
              converterVersion: 1,
              tables: [
                {
                  source: "fixture",
                  target: "panda_force_fixture",
                  columns: ["id", "body"],
                  sourceKeys: ["id"],
                  targetKeys: ["id"],
                  numericColumns: ["id"],
                  project: (r) => [r.id!, r.body!],
                },
              ],
              progress: async (value) => {
                await options.progress(value);
                if (value.stage === "copy" && interrupt) {
                  interrupt = false;
                  throw Error("Transport interrupted after commit");
                }
              },
            }),
        },
      ];
      const options = {
        state,
        operationId: id,
        registry,
        runtimeBindings: new Set(["fixtures"]),
        current: { schema: 1, driver: "sqlite" } as const,
        units,
        connect: async () => new SQL({ ...c, database: schema, adapter: "mysql", max: 3 }),
        prepare: async (directory: string) => {
          captures++;
          return {
            schema: 1 as const,
            operationId: id,
            sources: [await captureFrozenSQLiteSource({ id: "fixture", directory, sourcePath })],
            preservedModules: [],
            unitsFingerprint: migrationUnitsFingerprint(units),
          };
        },
      };
      const failed = await executeApplicationMigration(options);
      expect(failed.status).toBe("failed");
      expect(failed.canRetry).toBe(true);
      expect(failed.canCancel).toBe(false);
      expect(Number((await sql`SELECT count(*) n FROM panda_force_fixture`)[0].n)).toBe(100);
      expect((await sql`SELECT state FROM panda_force_database_installation WHERE id=1`)[0].state).toBe("staging");
      expect(await readApplicationDatabaseConfig(root)).toEqual({ schema: 1, driver: "sqlite" });
      const complete = await executeApplicationMigration(options);
      expect(complete.status).toBe("complete");
      expect(complete.modules[0]?.rows).toBe(205);
      expect(captures).toBe(1);
      expect((await sql`SELECT state FROM panda_force_database_installation WHERE id=1`)[0].state).toBe("active");
      expect(Number((await sql`SELECT count(*) n FROM panda_force_fixture`)[0].n)).toBe(205);
      expect(await state.read("", "pending")).toBeNull();
      await assertApplicationDatabaseActivation(state, await readApplicationDatabaseConfig(root), sql);
      await unlink(join(root, "config", "database.json"));
      await expect(
        assertApplicationDatabaseActivation(state, await readApplicationDatabaseConfig(root), null),
      ).rejects.toThrow("databaseActivationMismatch");
      const restored = JSON.parse(await readFile(join(state.root, "activation" + ".json"), "utf8"));
      expect(restored.operationId).toBe(id);
      const original = new Database(sourcePath, { readonly: true });
      expect(original.query("SELECT count(*) n FROM fixture").get()).toEqual({ n: 205 });
      original.close();
    } finally {
      await sql.close();
      await admin.unsafe(`DROP DATABASE ${schema}`);
      await admin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
