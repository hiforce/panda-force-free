import { test, expect } from "bun:test";
import type { SQL } from "bun";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { inspectTable } from "../../src/server/database/schema-inspection.js";
import type { SchemaTable, MigrationRecord } from "../../src/server/database/registry.js";

const definition = (name: string): SchemaTable => ({
  name,
  columns: [{ name: "id", type: "int", nullable: false, collation: null }],
  indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
});
function fixture() {
  const tables = new Map(["panda_force_first", "panda_force_second"].map((name) => [name, definition(name)])),
    records = new Map<string, Map<number, MigrationRecord>>(),
    queries: string[] = [];
  let ddl: (statement: string) => void = () => {};
  let failRecord = false;
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      queries.push(text);
      if (text.includes("GET_LOCK")) return [{ acquired: 1 }];
      if (text.includes("RELEASE_LOCK")) return [{}];
      const table = tables.get(String(values[0]));
      if (text.includes("information_schema.TABLES")) return table ? [{ found: 1 }] : [];
      if (text.includes("information_schema.COLUMNS")) {
        if (text.includes("AND COLUMN_NAME"))
          return table?.columns.some((column) => column.name === values[1]) ? [{ found: 1 }] : [];
        return (
          table?.columns.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.nullable ? "YES" : "NO",
            collation: column.collation ?? null,
            extra: column.autoIncrement ? "auto_increment" : "",
            defaultValue: column.defaultValue ?? null,
          })) ?? []
        );
      }
      if (text.includes("information_schema.STATISTICS")) {
        if (text.includes("AND INDEX_NAME"))
          return table?.indexes.some((index) => index.name === values[1]) ? [{ found: 1 }] : [];
        return (
          table?.indexes.flatMap((index) =>
            index.columns.map((column) => ({
              name: index.name,
              nonUnique: index.unique ? 0 : 1,
              columnName: column,
              prefix: null,
            })),
          ) ?? []
        );
      }
      if (text.startsWith("SELECT version,checksum")) {
        const history = records.get(String(values[0])),
          version = Number(values[1]),
          value = version
            ? history?.get(version)
            : [...(history?.values() ?? [])].sort((a, b) => b.version - a.version)[0];
        return value ? [{ ...value }] : [];
      }
      if (text.startsWith("INSERT INTO panda_force_schema_migrations")) {
        const module = String(values[0]);
        let history = records.get(module);
        if (!history) records.set(module, (history = new Map()));
        const row = {
          version: Number(values[1]),
          checksum: String(values[2]),
          step: Number(values[3]),
          state: values[4] as MigrationRecord["state"],
        };
        history.set(row.version, row);
        if (failRecord) {
          failRecord = false;
          throw Error("lost journal response");
        }
        return [];
      }
      throw Error("Unexpected fixture query");
    },
    {
      reserve: async () => sql,
      release: () => {},
      unsafe: async (statement: string) => {
        if (!statement.startsWith("CREATE TABLE IF NOT EXISTS panda_force_schema_migrations")) ddl(statement);
        return [];
      },
    },
  );
  return {
    set failRecord(value: boolean) {
      failRecord = value;
    },
    connection: new MySQLSchemaConnection(sql as unknown as SQL),
    tables,
    records,
    queries,
    get metadataReads() {
      return queries.filter((query) => query.includes("information_schema")).length;
    },
    get historyReads() {
      return queries.filter((query) => query.startsWith("SELECT version,checksum")).length;
    },
    set ddl(value: typeof ddl) {
      ddl = value;
    },
  };
}

test("stable exclusive inspection coalesces metadata and returns independent descriptions without caching outside the lock", async () => {
  const f = fixture(),
    c = f.connection;
  await c.describe("panda_force_first");
  await c.describe("panda_force_first");
  expect(f.metadataReads).toBe(4);
  await c.exclusive(async () => {
    const start = f.metadataReads,
      [first, second] = await Promise.all([c.describe("panda_force_first"), c.describe("panda_force_first")]);
    expect(f.metadataReads - start).toBe(2);
    first!.columns[0]!.type = "changed";
    second!.indexes.length = 0;
    expect((await c.describe("panda_force_first"))!.columns[0]!.type).toBe("int");
    expect(await c.table("panda_force_first")).toBe(true);
    expect(await c.column("panda_force_first", "id")).toBe(true);
    expect(await c.index("panda_force_first", "PRIMARY")).toBe(true);
    expect(await c.column("panda_force_first", "ID")).toBe(true);
    expect(await c.index("panda_force_first", "primary")).toBe(true);
    expect(await c.column("panda_force_first", "absent")).toBe(false);
    expect(await c.index("panda_force_first", "absent")).toBe(false);
    expect(f.metadataReads - start).toBe(2);
    expect(await c.table("absent")).toBe(false);
    expect(await c.table("absent")).toBe(false);
    expect(f.metadataReads - start).toBe(3);
  });
  const previous = f.metadataReads;
  await c.describe("panda_force_first");
  await c.describe("panda_force_first");
  expect(f.metadataReads - previous).toBe(4);
});

test("an uncertain journal write discards cached history before the next inspection", async () => {
  const f = fixture(),
    c = f.connection;
  await c.exclusive(async () => {
    expect(await c.history("sample", 0)).toBe(null);
    const before = f.historyReads;
    f.failRecord = true;
    await expect(c.record("sample", { version: 1, checksum: "v1", step: 1, state: "complete" })).rejects.toThrow(
      "lost journal response",
    );
    expect((await c.history("sample", 0))?.state).toBe("complete");
    expect(f.historyReads).toBe(before + 1);
  });
});

test("DDL invalidates the affected table after success or failure and missing indexes remain visible", async () => {
  const f = fixture(),
    c = f.connection,
    first = f.tables.get("panda_force_first")!,
    expected = structuredClone(first);
  expected.indexes.push({ name: "first_note", unique: false, columns: ["note"] });
  await c.exclusive(async () => {
    await c.describe(first.name);
    await c.describe("panda_force_second");
    expect(await c.index(first.name, "first_note")).toBe(false);
    f.ddl = () => {
      first.columns.push({ name: "note", type: "text", nullable: true, collation: "utf8mb4_bin" });
    };
    await c.execute("ALTER TABLE `panda_force_first` ADD COLUMN note TEXT");
    expect(await c.column(first.name, "note")).toBe(true);
    await c.describe(first.name);
    const beforeSecond = f.metadataReads;
    await c.describe("panda_force_second");
    expect(f.metadataReads).toBe(beforeSecond);
    f.ddl = () => {
      first.indexes.push({ name: "first_note", unique: false, columns: ["note"] });
    };
    await c.execute("CREATE INDEX `first_note` ON `fixture`.`panda_force_first`(note)");
    expect(await inspectTable(c, "sample", expected)).toEqual([]);
    f.ddl = () => {
      first.indexes = first.indexes.filter((index) => index.name !== "first_note");
    };
    await c.execute("ALTER TABLE panda_force_first DROP INDEX first_note");
    expect(await inspectTable(c, "sample", expected)).toEqual([
      { module: "sample", object: "panda_force_first.first_note", code: "missingIndex" },
    ]);
    const previous = f.metadataReads;
    f.ddl = () => {
      first.columns.push({ name: "uncertain", type: "int", nullable: true });
      throw Error("lost DDL response");
    };
    await expect(c.execute("ALTER TABLE panda_force_first ADD COLUMN uncertain INT")).rejects.toThrow(
      "lost DDL response",
    );
    expect(await c.column(first.name, "uncertain")).toBe(true);
    expect(f.metadataReads).toBe(previous + 1);
  });
});

test("journal writes update exact and latest cached history while a failed exclusive releases every cached result", async () => {
  const f = fixture(),
    c = f.connection;
  f.records.set("sample", new Map([[2, { version: 2, checksum: "v2", step: 1, state: "complete" }]]));
  await c.exclusive(async () => {
    expect((await c.history("sample", 0))!.version).toBe(2);
    expect(await c.history("sample", 1)).toBe(null);
    const reads = f.historyReads;
    await c.record("sample", { version: 1, checksum: "v1", step: 1, state: "complete" });
    expect((await c.history("sample", 0))!.version).toBe(2);
    expect((await c.history("sample", 1))!.checksum).toBe("v1");
    const value: MigrationRecord = { version: 3, checksum: "v3", step: 1, state: "running" };
    await c.record("sample", value);
    value.checksum = "changed";
    const latest = (await c.history("sample", 0))!;
    expect(latest.version).toBe(3);
    latest.checksum = "changed again";
    expect((await c.history("sample", 3))!.checksum).toBe("v3");
    expect(f.historyReads).toBe(reads);
  });
  await expect(
    c.exclusive(async () => {
      await c.describe("panda_force_second");
      throw Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  f.tables.get("panda_force_second")!.columns.push({ name: "external", type: "text", nullable: true });
  await c.exclusive(async () => {
    expect(await c.column("panda_force_second", "external")).toBe(true);
    expect((await c.history("sample", 0))!.version).toBe(3);
  });
});
