import type { DatabaseModule, SchemaTable, SchemaColumn, SchemaIndex, SchemaIssue } from "./registry.js";
import { inspectTable } from "./schema-inspection.js";
export interface MySQLColumn extends SchemaColumn {
  defaultValue?: string | number | null;
  autoIncrement?: boolean;
}
export interface MySQLModel {
  name: string;
  columns: readonly MySQLColumn[];
  indexes: readonly SchemaIndex[];
}
const quote = (name: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) throw Error("invalidDatabaseIdentifier");
  return "`" + name + "`";
};
export function modelDefinition(model: MySQLModel): SchemaTable {
  return {
    name: model.name,
    columns: model.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      collation: c.collation ?? (/char|text/.test(c.type) ? "utf8mb4_bin" : null),
      autoIncrement: !!c.autoIncrement,
      ...(c.defaultValue === undefined ? {} : { defaultValue: c.defaultValue }),
    })),
    indexes: model.indexes.map((i) => ({ ...i, columns: [...i.columns] })),
  };
}
export function createMySQLTable(model: MySQLModel) {
  if (!model.name.startsWith("panda_force_")) throw Error("unownedDatabaseTable");
  const fields = model.columns.map((c) => {
    if (
      !/^(?:(?:var)?char\([1-9][0-9]{0,4}\)|(?:long|medium)?text|(?:medium)?blob|bigint(?: unsigned)?|int|tinyint)$/.test(
        c.type,
      )
    )
      throw Error("invalidDatabaseColumnType");
    const fallback =
      c.defaultValue === undefined
        ? ""
        : " DEFAULT " +
          (c.defaultValue === null
            ? "NULL"
            : typeof c.defaultValue === "number"
              ? String(c.defaultValue)
              : "'" + c.defaultValue.replaceAll("'", "''") + "'");
    return (
      quote(c.name) +
      " " +
      c.type +
      (/char|text/.test(c.type) ? " COLLATE " + (c.collation ?? "utf8mb4_bin") : "") +
      (c.nullable ? " NULL" : " NOT NULL") +
      (c.autoIncrement ? " AUTO_INCREMENT" : "") +
      fallback
    );
  });
  for (const index of model.indexes) {
    const columns = index.columns
      .map((name) => {
        const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\(([1-9][0-9]*)\))?$/.exec(name);
        if (!m || !model.columns.some((c) => c.name === m[1])) throw Error("invalidDatabaseIndex");
        return quote(m[1]!) + (m[2] ? "(" + m[2] + ")" : "");
      })
      .join(",");
    fields.push(
      (index.name === "PRIMARY" ? "PRIMARY KEY" : (index.unique ? "UNIQUE KEY " : "KEY ") + quote(index.name)) +
        "(" +
        columns +
        ")",
    );
  }
  return (
    "CREATE TABLE IF NOT EXISTS " +
    quote(model.name) +
    "(" +
    fields.join(",") +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
  );
}
export function mysqlModelModule(
  id: string,
  models: readonly MySQLModel[],
  ready: { readWrite: boolean; importFrom: readonly ("sqlite" | "mysql")[] },
): DatabaseModule {
  const expected = models.map(modelDefinition);
  return {
    id,
    dependencies: [],
    backends: { mysql: ready },
    migrations: {
      mysql: [
        {
          version: 1,
          steps: models.map((m) => ({ id: m.name, sql: createMySQLTable(m), satisfied: (c) => c.table(m.name) })),
        },
      ],
    },
    async inspect(c) {
      const issues: SchemaIssue[] = [];
      for (const model of expected) issues.push(...(await inspectTable(c, id, model)));
      return issues;
    },
  };
}
export const mysqlInteger = (value: unknown) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw Error("invalidStoredDatabaseInteger");
  return result;
};
