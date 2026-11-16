import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { consistentMySQLRead } from "./consistent-read.js";
import { mysqlInteger } from "./mysql-model.js";
/** Native metadata facets share one reserved transaction. The composition root selects a trusted, application-owned mutex and numeric columns. */
export class MySQLSession {
  private current = new AsyncLocalStorage<SQL>();
  private integerFields: ReadonlySet<string>;
  private mutex: string;
  constructor(
    private pool: SQL,
    private options: {
      mutexTable: string;
      numericColumns?: readonly string[];
      transactionConnection?: <T>(work: (sql: SQL) => Promise<T>) => Promise<T>;
    },
  ) {
    if (!/^panda_force_[a-zA-Z0-9_]{1,52}$/.test(options.mutexTable)) throw Error("invalidDatabaseIdentifier");
    this.mutex = "`" + options.mutexTable + "`";
    this.integerFields = new Set(options.numericColumns ?? []);
  }
  async atomic<T>(work: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return work();
    const transaction =
      this.options.transactionConnection ??
      (<R>(work: (sql: SQL) => Promise<R>) => consistentMySQLRead(this.pool, work));
    return transaction(async (sql) => {
      await sql.unsafe(`INSERT INTO ${this.mutex}(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id`);
      await sql.unsafe(`SELECT id FROM ${this.mutex} WHERE id=1 FOR UPDATE`);
      return this.current.run(sql, work);
    });
  }
  private normalize<T>(row: Record<string, unknown>): T {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && (typeof value === "number" || typeof value === "bigint" || this.integerFields.has(key))
          ? mysqlInteger(value)
          : value,
      ]),
    ) as T;
  }
  async all<T = Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<T[]> {
    const sql = this.current.getStore();
    if (!sql) return this.atomic(() => this.all(statement, values));
    const rows = await sql.unsafe(statement, [...values] as never[]);
    return rows.map((row: Record<string, unknown>) => this.normalize<T>(row));
  }
  async one<T = Record<string, unknown>>(statement: string, values: readonly unknown[] = []): Promise<T | null> {
    return (await this.all<T>(statement, values))[0] ?? null;
  }
  async execute(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    const sql = this.current.getStore();
    if (!sql) return this.atomic(() => this.execute(statement, values));
    const result = await sql.unsafe(statement, [...values] as never[]);
    return {
      changes: mysqlInteger(result.affectedRows ?? 0),
      lastInsertRowid: mysqlInteger(result.lastInsertRowid ?? 0),
    };
  }
}
