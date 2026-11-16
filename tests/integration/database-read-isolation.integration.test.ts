import { test, expect } from "bun:test";
import type { SQL } from "bun";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { consistentMySQLRead } from "../../src/server/database/consistent-read.js";
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "read snapshots remain coherent on a READ COMMITTED connection without changing its session default",
  async () => {
    const f = await isolatedMySQLDatabase("isolation");
    try {
      await f.sql.unsafe("CREATE TABLE panda_force_snapshot_fixture(id INT PRIMARY KEY,value INT NOT NULL)");
      await f.sql`INSERT INTO panda_force_snapshot_fixture VALUES(1,10)`;
      const connection = await f.sql.reserve();
      await connection.unsafe("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const pool = { reserve: async () => connection } as unknown as SQL;
      await consistentMySQLRead(pool, async (tx) => {
        expect((await tx`SELECT value FROM panda_force_snapshot_fixture WHERE id=1`)[0].value).toBe(10);
        await f.sql`UPDATE panda_force_snapshot_fixture SET value=20 WHERE id=1`;
        expect((await tx`SELECT value FROM panda_force_snapshot_fixture WHERE id=1`)[0].value).toBe(10);
        expect((await tx.unsafe("SELECT @@session.transaction_isolation isolation"))[0].isolation).toBe(
          "READ-COMMITTED",
        );
      });
      expect((await f.sql`SELECT value FROM panda_force_snapshot_fixture WHERE id=1`)[0].value).toBe(20);
    } finally {
      await f.close();
    }
  },
  30000,
);
