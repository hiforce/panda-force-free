import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { consistentMySQLRead } from "../../database/consistent-read.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import { knowledgeMySQLModels } from "../../database/modules/knowledge.js";
import { embeddingMySQLModels } from "../../database/modules/search-embeddings.js";
import { searchMySQLModels } from "../../database/modules/search.js";
const integerColumns = new Set(
  [...knowledgeMySQLModels, ...searchMySQLModels, ...embeddingMySQLModels].flatMap((model) =>
    model.columns.filter((column) => /int/.test(column.type)).map((column) => column.name),
  ),
);
// Names shared with opaque identifiers (for example task counters versus audit generation hashes) cannot be normalized by name.
for (const model of [...knowledgeMySQLModels, ...searchMySQLModels, ...embeddingMySQLModels]) {
  for (const column of model.columns) if (!/int/.test(column.type)) integerColumns.delete(column.name);
}
for (const name of ["count", "n", "due", "rowid", "ruleRevision", "ruleManual"]) integerColumns.add(name);
/** Native async statements share a reserved transaction through nested domain facets. No SQLite connection is opened. */
export class MySQLMetadataContext {
  private current = new AsyncLocalStorage<SQL>();
  constructor(
    private readonly pool: SQL,
    readonly module: "knowledge" | "search" | "search-embeddings",
  ) {}
  async atomic<T>(work: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return work();
    return consistentMySQLRead(this.pool, async (sql) => {
      // One module fence preserves immediate-transaction admission and source-reference checks across pools.
      const table =
        this.module === "knowledge"
          ? "panda_force_knowledge_mutex"
          : this.module === "search"
            ? "panda_force_search_mutex"
            : "panda_force_embedding_mutex";
      await sql.unsafe(`INSERT INTO ${table}(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id`);
      await sql.unsafe(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
      return this.current.run(sql, work);
    });
  }
  private normalize<T>(row: Record<string, unknown>): T {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && (typeof value === "bigint" || typeof value === "number" || integerColumns.has(key))
          ? mysqlInteger(value)
          : value,
      ]),
    ) as T;
  }
  async all<T = Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<T[]> {
    const sql = this.current.getStore();
    if (!sql) return this.atomic(() => this.all<T>(statement, values));
    const rows = await sql.unsafe(statement, [...values] as never[]);
    return rows.map((row: Record<string, unknown>) => this.normalize<T>(row));
  }
  async one<T = Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<T | null> {
    return (await this.all<T>(statement, values))[0] ?? null;
  }
  async execute(statement: string, values: readonly unknown[] = []): Promise<{ changes: number }> {
    const sql = this.current.getStore();
    if (!sql) return this.atomic(() => this.execute(statement, values));
    const result = await sql.unsafe(statement, [...values] as never[]);
    return { changes: Number(result.affectedRows ?? 0) };
  }
}
