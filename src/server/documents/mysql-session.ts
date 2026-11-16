import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { consistentMySQLRead } from "../database/consistent-read.js";
import { mysqlInteger } from "../database/mysql-model.js";
const integers = new Set([
  "version",
  "createdAt",
  "updatedAt",
  "revision",
  "importedRevision",
  "number",
  "size",
  "width",
  "height",
  "deletedAt",
  "position",
  "count",
  "bytes",
  "trashed",
]);
/** Native async SQL only. One application mutex preserves the original cross-repository transaction boundary. */
export class MySQLDocumentSession {
  private readonly context = new AsyncLocalStorage<SQL>();
  constructor(readonly pool: SQL) {}
  private get sql() {
    return this.context.getStore() ?? this.pool;
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.pool.begin(async (sql) => {
      await sql`INSERT INTO panda_force_document_mutex(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id`;
      await sql`SELECT id FROM panda_force_document_mutex WHERE id=1 FOR UPDATE`;
      return this.context.run(sql, work);
    });
  }
  /** Trusted domain adapters use this only to share one relational transaction across owned modules. */
  withinConnection<T>(sql: SQL, work: () => T | Promise<T>): Promise<T> {
    return this.context.run(sql, async () => work());
  }
  transactionConnection<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
    return this.transaction(() => work(this.sql));
  }
  async lockConnection(sql: SQL): Promise<void> {
    await sql`INSERT INTO panda_force_document_mutex(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id`;
    await sql`SELECT id FROM panda_force_document_mutex WHERE id=1 FOR UPDATE`;
  }
  async snapshot<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return consistentMySQLRead(this.pool, (sql) => this.context.run(sql, async () => work()));
  }
  private decode<T>(row: any): T {
    const result = { ...row };
    for (const key of Object.keys(result)) {
      if (result[key] !== null && integers.has(key)) result[key] = mysqlInteger(result[key]);
    }
    for (const key of ["pathHash", "sourceHash", "activePathHash", "activeLocale"]) delete result[key];
    return result;
  }
  async all<T = any>(sql: string, values: any[] = []): Promise<T[]> {
    return (await this.sql.unsafe(sql, values)).map((r: any) => this.decode<T>(r));
  }
  async one<T = any>(sql: string, values: any[] = []): Promise<T | null> {
    return (await this.all<T>(sql, values))[0] ?? null;
  }
  async run(sql: string, values: any[] = []) {
    const result = await this.sql.unsafe(sql, values);
    return { changes: result.affectedRows ?? result.count ?? 0 };
  }
  statement(sql: string) {
    return { run: (...values: any[]) => this.run(sql, values) };
  }
}
export const documentKeyHash = (value: string) => createHash("sha256").update(value).digest("hex");
