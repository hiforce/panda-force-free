import { test, expect } from "bun:test";
import type { SQL } from "bun";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { inspectTable } from "../../src/server/database/schema-inspection.js";
import type { SchemaTable } from "../../src/server/database/registry.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "exclusive MySQL schema metadata is reused only until DDL or lock release, including missing indexes",
  async () => {
    const database = await isolatedMySQLDatabase("metacache");
    try {
      let metadataReads = 0,
        historyReads = 0;
      function observe(sql: SQL): SQL {
        return new Proxy(sql, {
          apply(target, _receiver, args) {
            const statement = Array.isArray(args[0]) ? args[0].join("?") : "";
            if (statement.includes("information_schema")) metadataReads++;
            if (statement.startsWith("SELECT version,checksum")) historyReads++;
            return Reflect.apply(target, target, args);
          },
          get(target, key) {
            if (key === "reserve") return async () => observe((await target.reserve()) as unknown as SQL);
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      const connection = new MySQLSchemaConnection(observe(database.sql)),
        tables: SchemaTable[] = ["panda_force_cache_one", "panda_force_cache_two"].map((name) => ({
          name,
          columns: [{ name: "id", type: "int", nullable: false, collation: null }],
          indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
        }));
      await connection.exclusive(async () => {
        for (const table of tables) {
          expect(await connection.table(table.name)).toBe(false);
          await connection.execute(`CREATE TABLE ${table.name}(id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
          expect(await connection.table(table.name)).toBe(true);
          expect(await inspectTable(connection, "fixture", table)).toEqual([]);
        }
        expect(metadataReads).toBe(8);
        for (const table of tables) expect(await inspectTable(connection, "fixture", table)).toEqual([]);
        expect(metadataReads).toBe(8);
        const first = tables[0]!,
          second = tables[1]!,
          index = { name: "cache_value", unique: false, columns: ["value"] };
        expect(await connection.index(first.name, index.name)).toBe(false);
        await connection.execute(`ALTER TABLE ${first.name} ADD COLUMN value VARCHAR(32) COLLATE utf8mb4_bin`);
        expect(await connection.column(first.name, "value")).toBe(true);
        await connection.execute(`CREATE INDEX cache_value ON ${first.name}(value)`);
        const indexed = { ...first, indexes: [...first.indexes, index] };
        expect(await inspectTable(connection, "fixture", indexed)).toEqual([]);
        const before = metadataReads;
        await connection.describe(second.name);
        expect(metadataReads).toBe(before);
        await connection.execute(`ALTER TABLE ${first.name} DROP INDEX cache_value`);
        expect(await inspectTable(connection, "fixture", indexed)).toEqual([
          { module: "fixture", object: first.name + ".cache_value", code: "missingIndex" },
        ]);
        expect(await connection.history("fixture", 0)).toBe(null);
        const journalReads = historyReads;
        await connection.record("fixture", { version: 1, checksum: "a".repeat(64), step: 1, state: "complete" });
        expect((await connection.history("fixture", 0))?.version).toBe(1);
        expect((await connection.history("fixture", 1))?.state).toBe("complete");
        expect(historyReads).toBe(journalReads);
      });
      await database.sql.unsafe("CREATE INDEX cache_value ON panda_force_cache_one(value)");
      await connection.exclusive(async () => {
        const before = metadataReads;
        expect(await connection.index("panda_force_cache_one", "cache_value")).toBe(true);
        expect(metadataReads).toBe(before + 1);
      });
      await database.sql.unsafe("DROP INDEX cache_value ON panda_force_cache_one");
      await connection.exclusive(async () => {
        expect(await connection.index("panda_force_cache_one", "cache_value")).toBe(false);
        const before = metadataReads;
        await connection.describe("panda_force_cache_one");
        await connection.describe("panda_force_cache_two");
        expect(metadataReads).toBe(before + 4);
        const stable = metadataReads;
        await connection.describe("panda_force_cache_one");
        await connection.describe("panda_force_cache_two");
        expect(metadataReads).toBe(stable);
      });
    } finally {
      await database.close();
    }
  },
  120000,
);
