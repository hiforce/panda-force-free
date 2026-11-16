import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { consistentMySQLRead } from "../database/consistent-read.js";
import { mysqlInteger } from "../database/mysql-model.js";
export type AsyncStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : T[K];
};
interface LedgerContext {
  sql: SQL;
  guard: string | null;
}
export type MySQLLedgerTransaction = <T>(work: (connection: SQL) => Promise<T>) => Promise<T>;
const transactionOwners = new WeakMap<SQL, object>();
const contexts = new WeakMap<SQL, AsyncLocalStorage<LedgerContext>>();
/** Native asynchronous statements share one connection across participating stores. File bodies stay outside SQL. */
export class MySQLLedger {
  readonly transactionOwner: object;
  private readonly context: AsyncLocalStorage<LedgerContext>;
  constructor(
    private readonly pool: SQL,
    private readonly guard: string,
    private readonly numeric: readonly string[],
    private readonly outerTransaction?: MySQLLedgerTransaction,
  ) {
    if (!/^panda_force_[a-z_]+_guard$/.test(guard)) throw new Error("invalidDatabaseIdentifier");
    let context = contexts.get(pool);
    if (!context) contexts.set(pool, (context = new AsyncLocalStorage<LedgerContext>()));
    this.context = context;
    let owner = transactionOwners.get(pool);
    if (!owner) transactionOwners.set(pool, (owner = Object.freeze({})));
    this.transactionOwner = owner;
  }
  protected query<R = Record<string, unknown>, P extends unknown[] = unknown[]>(statement: string) {
    const rows = async (...parameters: P): Promise<R[]> => {
      const values = await (this.context.getStore()?.sql ?? this.pool).unsafe(
        statement,
        parameters as unknown as never[],
      );
      return values.map((row: Record<string, unknown>) => {
        const result = { ...row };
        for (const column of this.numeric)
          if (Object.hasOwn(result, column) && result[column] !== null) result[column] = mysqlInteger(result[column]);
        return result as R;
      });
    };
    return {
      all: rows,
      get: async (...parameters: P): Promise<R | null> => (await rows(...parameters))[0] ?? null,
      run: async (...parameters: P) => {
        if (this.context.getStore()?.guard !== this.guard) throw new Error("databaseWriteTransactionRequired");
        const result = await (this.context.getStore()?.sql ?? this.pool).unsafe(
          statement,
          parameters as unknown as never[],
        );
        return {
          changes: mysqlInteger(result.affectedRows ?? result.count ?? 0),
          lastInsertRowid: result.lastInsertRowid,
        };
      },
    };
  }
  protected async readSnapshot<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return consistentMySQLRead(this.pool, (sql) => this.context.run({ sql, guard: null }, work));
  }
  protected async transaction<T>(work: () => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) {
      if (active.guard !== this.guard) throw new Error("databaseWriteTransactionRequired");
      return work();
    }
    const execute = async (sql: SQL) => {
      await this.lockConnection(sql);
      return this.withinConnection(sql, work);
    };
    return this.outerTransaction ? this.outerTransaction(execute) : this.pool.begin(execute);
  }
  /** Composition obtains the document mutex before this extension mutex on the same connection. */
  async lockConnection(sql: SQL) {
    await sql.unsafe(`INSERT INTO ${this.guard}(id) VALUES(1) ON DUPLICATE KEY UPDATE id=VALUES(id)`);
    await sql.unsafe(`SELECT id FROM ${this.guard} WHERE id=1 FOR UPDATE`);
  }
  withinConnection<T>(sql: SQL, work: () => Promise<T>): Promise<T> {
    return this.context.run({ sql, guard: this.guard }, work);
  }
}
/** Domain ports can accept the existing synchronous SQLite adapters during phased migration. */
export type CompatibleStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : T[K];
};
