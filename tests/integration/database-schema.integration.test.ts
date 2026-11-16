import { test, expect } from "bun:test";
import { SQL } from "bun";
import { DatabaseRegistry, type DatabaseModule } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlBotModule } from "../../src/server/database/modules/bots.js";

const path = process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE;
test.skipIf(!path)(
  "MySQL module DDL preserves business tables, resumes committed DDL and fences concurrent upgrades",
  async () => {
    const config = await Bun.file(path!).json();
    if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test")
      throw new Error("Use a dedicated local MySQL test container");
    const sql = new SQL({
      ...config,
      adapter: "mysql",
      max: 4,
      connectionTimeout: 5,
      idleTimeout: 2,
    });
    try {
      await sql.unsafe("CREATE TABLE IF NOT EXISTS existing_business(id INT PRIMARY KEY,value VARCHAR(64))");
      await sql`INSERT INTO existing_business VALUES(42,'retained') ON DUPLICATE KEY UPDATE value=VALUES(value)`;
      const connection = new MySQLSchemaConnection(sql),
        registry = new DatabaseRegistry().register(mysqlBotModule);
      await registry.upgrade(connection);
      expect(await registry.inspect(connection)).toEqual([]);
      await sql`INSERT INTO panda_force_bots VALUES('fixture','owner','fixture','{}') ON DUPLICATE KEY UPDATE data=VALUES(data)`;
      await registry.upgrade(connection);
      expect((await sql`SELECT value FROM existing_business WHERE id=42`)[0].value).toBe("retained");
      expect((await sql`SELECT id FROM panda_force_bots WHERE id='fixture'`)[0].id).toBe("fixture");
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12),
        moduleId = "recovery-" + suffix,
        table = "panda_force_recovery_" + suffix;
      const recovery: DatabaseModule = {
        id: moduleId,
        dependencies: [],
        migrations: {
          mysql: [
            {
              version: 1,
              steps: [
                {
                  id: "create",
                  sql: `CREATE TABLE ${table}(id INT PRIMARY KEY)`,
                  satisfied: (c) => c.table(table),
                },
              ],
            },
          ],
        },
        inspect: async (c) =>
          (await c.table(table)) ? [] : [{ module: moduleId, object: "table", code: "missingTable" }],
      };
      const broken = new MySQLSchemaConnection(sql),
        execute = broken.execute.bind(broken);
      broken.execute = async (command) => {
        await execute(command);
        throw new Error("Interrupted after DDL commit");
      };
      await expect(new DatabaseRegistry().register(recovery).upgrade(broken)).rejects.toThrow(
        "Interrupted after DDL commit",
      );
      expect(await connection.table(table)).toBe(true);
      await new DatabaseRegistry().register(recovery).upgrade(connection);
      expect((await connection.history(moduleId, 1))?.state).toBe("complete");
      let release!: () => void, ready!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve)),
        started = new Promise<void>((resolve) => (ready = resolve));
      const first = connection.exclusive(async () => {
        ready();
        await held;
      });
      await started;
      try {
        await expect(new MySQLSchemaConnection(sql).exclusive(async () => {})).rejects.toThrow("schemaMigrationBusy");
      } finally {
        release();
        await first;
      }
    } finally {
      await sql.close();
    }
  },
  30000,
);
