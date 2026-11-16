import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { DatabaseRegistry, type DatabaseModule } from "../../src/server/database/registry.js";
import { SQLiteSchemaConnection } from "../../src/server/database/sqlite-schema.js";
import { inspectTable } from "../../src/server/database/schema-inspection.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import {
  createApplicationDatabaseRegistry,
  applicationDatabaseModules,
} from "../../src/server/database/application-registry.js";
const module = (id = "sample", deps: string[] = []): DatabaseModule => ({
  id,
  dependencies: deps,
  migrations: {
    sqlite: [
      {
        version: 1,
        steps: [
          {
            id: "table",
            sql: `CREATE TABLE panda_force_${id}(id TEXT PRIMARY KEY,value TEXT)`,
            satisfied: async (c) => (c as SQLiteSchemaConnection).table("panda_force_" + id),
          },
          {
            id: "index",
            sql: `CREATE INDEX panda_force_${id}_value ON panda_force_${id}(value)`,
            satisfied: async (c) =>
              (c as SQLiteSchemaConnection).index("panda_force_" + id, "panda_force_" + id + "_value"),
          },
        ],
      },
    ],
  },
  inspect: async (c) =>
    (await (c as SQLiteSchemaConnection).table("panda_force_" + id)) &&
    (await (c as SQLiteSchemaConnection).index("panda_force_" + id, "panda_force_" + id + "_value"))
      ? []
      : [{ module: id, object: id, code: "missingIndex" }],
});
test("module schema upgrades are registered, additive, repeatable and preserve unrelated tables", async () => {
  const db = new Database(":memory:"),
    connection = new SQLiteSchemaConnection(db),
    registry = new DatabaseRegistry().register(module());
  try {
    db.exec("CREATE TABLE existing_business(id INTEGER PRIMARY KEY);INSERT INTO existing_business VALUES(42)");
    expect(await registry.upgrade(connection)).toEqual([]);
    db.query("INSERT INTO panda_force_sample VALUES(?,?)").run("id", "retained");
    await registry.upgrade(connection);
    expect(db.query("SELECT * FROM panda_force_sample").all()).toEqual([{ id: "id", value: "retained" }]);
    expect(db.query("SELECT id FROM existing_business").get()).toEqual({ id: 42 });
    expect((await connection.history("sample", 1))?.state).toBe("complete");
  } finally {
    db.close();
  }
});
test("missing backends, dependency cycles and destructive DDL block before schema work", async () => {
  expect(() => new DatabaseRegistry().register(module()).register(module())).toThrow("duplicateModule");
  expect(() => new DatabaseRegistry().register(module("alpha", ["beta"])).ordered()).toThrow("missingDependency");
  expect(() =>
    new DatabaseRegistry()
      .register(module("alpha", ["beta"]))
      .register(module("beta", ["alpha"]))
      .ordered(),
  ).toThrow("dependencyCycle");
  for (const sql of [
    "DROP TABLE business",
    "ALTER TABLE business DROP COLUMN id",
    "CREATE TABLE x(id TEXT);DELETE FROM business",
  ]) {
    const m = module();
    m.migrations.sqlite![0]!.steps[0]!.sql = sql;
    expect(() => new DatabaseRegistry().register(m)).toThrow("unsafeStatement");
  }
  const c = {
    dialect: "mysql" as const,
    exclusive: () => {
      throw new Error("must not connect");
    },
  };
  await expect(new DatabaseRegistry().register(module()).upgrade(c as any)).rejects.toThrow("missingDialect");
});
test("changed migrations and missing required indexes fail self inspection", async () => {
  const db = new Database(":memory:"),
    connection = new SQLiteSchemaConnection(db),
    original = module();
  try {
    await new DatabaseRegistry().register(original).upgrade(connection);
    const changed = module();
    changed.migrations.sqlite![0]!.steps[0]!.sql += " ";
    await expect(new DatabaseRegistry().register(changed).upgrade(connection)).rejects.toThrow("changedMigration");
    db.exec("DROP INDEX panda_force_sample_value");
    expect(await new DatabaseRegistry().register(original).inspect(connection)).toHaveLength(1);
    await expect(new DatabaseRegistry().register(original).upgrade(connection)).rejects.toThrow("schemaDrift");
  } finally {
    db.close();
  }
});

test("schema availability cannot authorize a whole-application storage cutover", () => {
  const schemaOnly = module();
  let registry = new DatabaseRegistry().register(schemaOnly);
  expect(registry.readiness("sqlite")).toEqual([{ module: "sample", schema: true, readWrite: false, importer: true }]);
  expect(() => registry.assertCutoverReady("sqlite")).toThrow("missingBackend");
  const implemented = module();
  implemented.backends = { sqlite: { readWrite: true, importFrom: [] } };
  registry = new DatabaseRegistry().register(implemented);
  expect(() => registry.assertCutoverReady("sqlite", "mysql")).toThrow("missingImporter");
  expect(() => registry.assertCutoverReady("sqlite")).not.toThrow();
  implemented.migrations.sqlite![0]!.steps[0]!.sql = "DROP TABLE business";
  expect(registry.ordered()[0]!.migrations.sqlite![0]!.steps[0]!.sql).toStartWith("CREATE TABLE");
  expect(() => {
    registry.ordered()[0]!.migrations.sqlite![0]!.steps[0]!.sql = "DROP TABLE business";
  }).toThrow();
});

test("application cutover checks every business domain instead of activating a partially supported backend", () => {
  const registry = createApplicationDatabaseRegistry(),
    ready = registry.readiness("mysql");
  expect(
    ready.filter((v) => applicationDatabaseModules.includes(v.module as (typeof applicationDatabaseModules)[number])),
  ).toHaveLength(applicationDatabaseModules.length);
  expect(ready.find((v) => v.module === "bots")).toMatchObject({ schema: true, readWrite: true, importer: true });
  expect(ready.find((v) => v.module === "documents")).toMatchObject({
    schema: true,
    readWrite: true,
    importer: true,
  });
  expect(() => registry.assertCutoverReady("mysql")).not.toThrow();
  const incomplete = createApplicationDatabaseRegistry([
    { ...mysqlDocumentsModule, backends: { mysql: { readWrite: false, importFrom: ["sqlite"] } } },
  ]);
  expect(() => incomplete.assertCutoverReady("mysql")).toThrow("missingBackend");
});

test("self inspection checks column types, nullability, unique constraints and ordered index columns", async () => {
  const db = new Database(":memory:"),
    c = new SQLiteSchemaConnection(db);
  try {
    db.exec(
      "CREATE TABLE panda_force_contract(id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT);CREATE INDEX panda_force_contract_owner ON panda_force_contract(owner,value)",
    );
    const expected = (await c.describe("panda_force_contract"))!;
    expect(await inspectTable(c, "sample", expected)).toEqual([]);
    expected.columns.find((v) => v.name === "value")!.nullable = false;
    expected.columns.find((v) => v.name === "owner")!.type = "integer";
    expected.indexes.find((v) => v.name === "panda_force_contract_owner")!.unique = true;
    expect((await inspectTable(c, "sample", expected)).map((v) => v.code)).toEqual([
      "incompatibleColumn",
      "incompatibleColumn",
      "incompatibleIndex",
    ]);
    expected.indexes.find((v) => v.name === "panda_force_contract_owner")!.unique = false;
    expected.indexes.find((v) => v.name === "panda_force_contract_owner")!.columns.reverse();
    expect((await inspectTable(c, "sample", expected)).at(-1)?.code).toBe("incompatibleIndex");
    const existing = module("contract");
    existing.inspect = () => inspectTable(c, "contract", expected);
    expect(
      (await new DatabaseRegistry().register(existing).inspect(c)).some((v) => v.code === "migrationIncomplete"),
    ).toBe(true);
  } finally {
    db.close();
  }
});
