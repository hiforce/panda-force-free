import { test, expect } from "bun:test";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSQLiteModule, type MigrationTable } from "../../src/server/database/data-migration.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
const path = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!path)(
  "wide frozen records import with bounded batches, exact binary checksums and resumable policy correction",
  async () => {
    const config = await Bun.file(path!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw Error("Dedicated loopback fixture required");
    const schema = "panda_force_test_large_" + randomUUID().replaceAll("-", ""),
      admin = new SQL({ ...config, adapter: "mysql", max: 2 });
    await admin.unsafe(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const sql = new SQL({ ...config, database: schema, adapter: "mysql", max: 2 }),
      root = await mkdtemp(join(tmpdir(), "pf-large-import-")),
      snapshotPath = join(root, "source.sqlite");
    try {
      await new DatabaseRegistry().register(mysqlDataMigrationModule).upgrade(new MySQLSchemaConnection(sql));
      await sql.unsafe(
        "CREATE TABLE panda_force_large_fixture(id INT PRIMARY KEY AUTO_INCREMENT,body LONGTEXT NOT NULL,bytes LONGBLOB NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
      );
      const source = new Database(snapshotPath, { create: true, strict: true }),
        body = "文".repeat(700000) + '\n\\"🧭',
        bytes = new Uint8Array(65536).map((_, i) => i % 256);
      source.exec(
        "CREATE TABLE large_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,bytes BLOB NOT NULL)",
      );
      source.transaction(() => {
        for (let id = 1; id <= 5; id++)
          source.query("INSERT INTO large_fixture VALUES(?,?,?)").run(id, body + id, bytes);
        source.query("INSERT INTO large_fixture VALUES(?,?,?)").run(40, "deleted", bytes);
        source.exec("DELETE FROM large_fixture WHERE id=40");
      })();
      source.close();
      await chmod(snapshotPath, 0o400);
      const tables: MigrationTable[] = [
        {
          source: "large_fixture",
          target: "panda_force_large_fixture",
          columns: ["id", "body", "bytes"],
          sourceKeys: ["id"],
          targetKeys: ["id"],
          numericColumns: ["id"],
          project: (r) => [r.id!, r.body!, r.bytes!],
        },
      ];
      const options = {
        sql,
        snapshotPath,
        migrationId: randomUUID(),
        module: "large-fixture",
        converterVersion: 1,
        tables,
      };
      await expect(migrateSQLiteModule(options)).rejects.toThrow("migrationRecordTooLarge");
      expect(Number((await sql`SELECT COUNT(*) n FROM panda_force_large_fixture`)[0].n)).toBe(0);
      const limits = { maxRecordBytes: 3 * 1024 * 1024, maxBatchBytes: 4 * 1024 * 1024 };
      let interrupted = false;
      await expect(
        migrateSQLiteModule({
          ...options,
          limits,
          progress: (value) => {
            if (value.stage === "copy" && !interrupted) {
              interrupted = true;
              throw Error("Interruption after a durable wide row");
            }
          },
        }),
      ).rejects.toThrow("Interruption after a durable wide row");
      expect(Number((await sql`SELECT COUNT(*) n FROM panda_force_large_fixture`)[0].n)).toBe(1);
      const result = await migrateSQLiteModule({ ...options, limits });
      expect(result.state).toBe("complete");
      expect(Number((await sql`SELECT COUNT(*) n FROM panda_force_large_fixture`)[0].n)).toBe(5);
      const row = (await sql`SELECT body,bytes FROM panda_force_large_fixture WHERE id=3`)[0];
      expect(row.body === body + 3).toBe(true);
      expect(Buffer.from(row.bytes).equals(Buffer.from(bytes))).toBe(true);
      await migrateSQLiteModule({ ...options, limits });
      await expect(
        migrateSQLiteModule({ ...options, limits: { maxRecordBytes: 1024, maxBatchBytes: 512 } }),
      ).rejects.toThrow("invalidMigrationLimits");
      expect((await sql`SELECT state FROM panda_force_data_migration_runs WHERE module='large-fixture'`)[0].state).toBe(
        "complete",
      );
      await sql`INSERT INTO panda_force_large_fixture(body,bytes) VALUES('next',${bytes})`;
      expect(Number((await sql`SELECT id FROM panda_force_large_fixture WHERE body='next'`)[0].id)).toBe(41);
    } finally {
      await sql.close();
      await admin.unsafe(`DROP DATABASE ${schema}`);
      await admin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
