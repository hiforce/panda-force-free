import { SQL } from "bun";
import type { SchemaConnection, MigrationRecord, SchemaTable } from "./registry.js";

interface SchemaCache {
  tables: Map<string, Promise<boolean>>;
  columns: Map<string, Map<string, Promise<boolean>>>;
  indexes: Map<string, Map<string, Promise<boolean>>>;
  descriptions: Map<string, Promise<SchemaTable | null>>;
  history: Map<string, Map<number, Promise<MigrationRecord | null>>>;
}
const cache = (): SchemaCache => ({
  tables: new Map(),
  columns: new Map(),
  indexes: new Map(),
  descriptions: new Map(),
  history: new Map(),
});
function retain<K, V>(values: Map<K, Promise<V>>, key: K, value: Promise<V>) {
  values.set(key, value);
  void value.catch(() => {
    if (values.get(key) === value) values.delete(key);
  });
  return value;
}
function remember<K, V>(values: Map<K, Promise<V>>, key: K, read: () => Promise<V>) {
  return values.get(key) ?? retain(values, key, read());
}
function nested<K, V>(values: Map<string, Map<K, Promise<V>>>, name: string) {
  let result = values.get(name);
  if (!result) values.set(name, (result = new Map()));
  return result;
}
const cloneTable = (table: SchemaTable | null): SchemaTable | null =>
  table && {
    ...table,
    columns: table.columns.map((column) => ({ ...column })),
    indexes: table.indexes.map((index) => ({ ...index, columns: [...index.columns] })),
  };
/** Unknown statements invalidate the whole session; recognized single-table DDL preserves other table reads. */
function changedTable(sql: string) {
  if (sql.replace(/;\s*$/, "").includes(";") || /\bRENAME\b/i.test(sql)) return null;
  const start = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  const identifier = "(?:`(?:``|[^`])+`|[a-zA-Z_][a-zA-Z0-9_$]*)",
    name = `(${identifier}(?:\\s*\\.\\s*${identifier})?)`;
  const match =
    new RegExp(`^(?:CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+)${name}`, "i").exec(start) ??
    new RegExp(
      `^(?:CREATE\\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\\s+)?INDEX\\s+${identifier}\\s+ON\\s+|DROP\\s+INDEX\\s+${identifier}\\s+ON\\s+)${name}`,
      "i",
    ).exec(start);
  return (
    match?.[1]
      ?.match(/`(?:``|[^`])+`|[a-zA-Z_][a-zA-Z0-9_$]*/g)
      ?.at(-1)
      ?.replace(/^`|`$/g, "")
      .replaceAll("``", "`") ?? null
  );
}

/** The reserved connection owns both the advisory lock and the DDL journal. MySQL DDL is not transactionally rolled back. */
export class MySQLSchemaConnection implements SchemaConnection {
  readonly dialect = "mysql" as const;
  private connection: SQL;
  private busy = false;
  private cache: SchemaCache | null = null;
  constructor(private readonly pool: SQL) {
    this.connection = pool;
  }
  async execute(sql: string) {
    try {
      await this.connection.unsafe(sql);
    } finally {
      if (this.cache) {
        const table = changedTable(sql);
        if (table) {
          for (const entries of [this.cache.tables, this.cache.columns, this.cache.indexes, this.cache.descriptions])
            for (const key of entries.keys()) if (key.toLowerCase() === table.toLowerCase()) entries.delete(key);
          if (table.toLowerCase() === "panda_force_schema_migrations") this.cache.history.clear();
        } else this.cache = cache();
      }
    }
  }
  async table(name: string) {
    const known = this.cache?.descriptions.get(name);
    if (known) return (await known) !== null;
    const read = async () =>
      !!(
        await this
          .connection`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${name}`
      ).length;
    return this.cache ? remember(this.cache.tables, name, read) : read();
  }
  async column(table: string, column: string) {
    const known = this.cache?.descriptions.get(table);
    if (known) return !!(await known)?.columns.some((value) => value.name.toLowerCase() === column.toLowerCase());
    const read = async () =>
      !!(
        await this
          .connection`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND COLUMN_NAME=${column}`
      ).length;
    return this.cache ? remember(nested(this.cache.columns, table), column, read) : read();
  }
  async index(table: string, index: string) {
    const known = this.cache?.descriptions.get(table);
    if (known) return !!(await known)?.indexes.some((value) => value.name.toLowerCase() === index.toLowerCase());
    const read = async () =>
      !!(
        await this
          .connection`SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND INDEX_NAME=${index}`
      ).length;
    return this.cache ? remember(nested(this.cache.indexes, table), index, read) : read();
  }
  async describe(table: string): Promise<SchemaTable | null> {
    const value = this.cache
      ? await remember(this.cache.descriptions, table, () => this.readDescription(table))
      : await this.readDescription(table);
    return cloneTable(value);
  }
  private async readDescription(table: string): Promise<SchemaTable | null> {
    const columns = await this
      .connection`SELECT COLUMN_NAME name,LOWER(COLUMN_TYPE) type,IS_NULLABLE nullable,COLLATION_NAME collation,EXTRA extra,COLUMN_DEFAULT defaultValue FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} ORDER BY ORDINAL_POSITION`;
    if (!columns.length) return null;
    const rows = await this
      .connection`SELECT INDEX_NAME name,NON_UNIQUE nonUnique,COLUMN_NAME columnName,SUB_PART prefix FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} ORDER BY INDEX_NAME,SEQ_IN_INDEX`;
    const indexes: SchemaTable["indexes"] = [];
    for (const row of rows) {
      let index = indexes.find((i) => i.name === row.name);
      if (!index) {
        index = { name: row.name, unique: !row.nonUnique, columns: [] };
        indexes.push(index);
      }
      index.columns.push(row.columnName + (row.prefix ? "(" + row.prefix + ")" : ""));
    }
    return {
      name: table,
      columns: columns.map(
        (c: {
          name: string;
          type: string;
          nullable: string;
          collation: string | null;
          extra: string;
          defaultValue: string | null;
        }) => ({
          name: c.name,
          type: c.type.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, "$1"),
          nullable: c.nullable === "YES",
          collation: c.collation,
          autoIncrement: c.extra.includes("auto_increment"),
          defaultValue: c.defaultValue,
        }),
      ),
      indexes,
    };
  }
  async history(module: string, version: number): Promise<MigrationRecord | null> {
    const value = this.cache
      ? await remember(nested(this.cache.history, module), version, () => this.readHistory(module, version))
      : await this.readHistory(module, version);
    return value ? { ...value } : null;
  }
  private async readHistory(module: string, version: number): Promise<MigrationRecord | null> {
    const rows = await this
      .connection`SELECT version,checksum,step,state FROM panda_force_schema_migrations WHERE module=${module} AND (${version}=0 OR version=${version}) ORDER BY version DESC LIMIT 1`;
    return rows[0] ?? null;
  }
  async record(module: string, value: MigrationRecord) {
    value = { ...value };
    try {
      await this
        .connection`INSERT INTO panda_force_schema_migrations(module,version,checksum,step,state,updatedAt) VALUES(${module},${value.version},${value.checksum},${value.step},${value.state},${Date.now()}) ON DUPLICATE KEY UPDATE checksum=VALUES(checksum),step=VALUES(step),state=VALUES(state),updatedAt=VALUES(updatedAt)`;
    } catch (error) {
      this.cache?.history.delete(module);
      throw error;
    }
    if (this.cache) {
      const records = nested(this.cache.history, module),
        latest = records.get(0);
      retain(records, value.version, Promise.resolve(value));
      if (latest)
        retain(
          records,
          0,
          latest.then(
            (previous) => (!previous || previous.version <= value.version ? value : previous),
            () => this.readHistory(module, 0),
          ),
        );
    }
  }
  async exclusive<T>(work: () => Promise<T>) {
    if (this.busy) throw new Error("schemaMigrationBusy");
    this.busy = true;
    let reserved: Awaited<ReturnType<SQL["reserve"]>> | undefined,
      acquired = false;
    try {
      reserved = await this.pool.reserve();
      this.connection = reserved;
      acquired =
        Number(
          (await reserved`SELECT GET_LOCK(CONCAT('pf-schema:',LEFT(SHA2(DATABASE(),256),40)),0) acquired`)[0].acquired,
        ) === 1;
      if (!acquired) throw new Error("schemaMigrationBusy");
      await reserved.unsafe(
        `CREATE TABLE IF NOT EXISTS panda_force_schema_migrations(module VARCHAR(48) COLLATE utf8mb4_bin NOT NULL,version INT NOT NULL,checksum CHAR(64) NOT NULL,step INT NOT NULL,state VARCHAR(16) NOT NULL,updatedAt BIGINT NOT NULL,PRIMARY KEY(module,version)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
      );
      this.cache = cache();
      return await work();
    } finally {
      this.cache = null;
      try {
        if (acquired && reserved)
          await reserved`SELECT RELEASE_LOCK(CONCAT('pf-schema:',LEFT(SHA2(DATABASE(),256),40)))`;
      } finally {
        this.connection = this.pool;
        reserved?.release();
        this.busy = false;
      }
    }
  }
}
