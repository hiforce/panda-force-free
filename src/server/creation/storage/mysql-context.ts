import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { consistentMySQLRead } from "../../database/consistent-read.js";
import { CreationError } from "../contracts.js";
export function creationLedgerNamespace(value: string) {
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))
    throw new CreationError("invalidInput");
  return value;
}
/** Every facet shares this context and the same durable namespace lock. */
export class MySQLCreationContext {
  private readonly context = new AsyncLocalStorage<SQL>();
  readonly namespace: string;
  constructor(
    private readonly pool: SQL,
    namespace: string,
  ) {
    this.namespace = creationLedgerNamespace(namespace);
  }
  get sql() {
    return this.context.getStore() ?? this.pool;
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.pool.begin(async (sql) => {
      await sql`INSERT INTO panda_force_creation_ledgers(namespace) VALUES(${this.namespace}) ON DUPLICATE KEY UPDATE namespace=VALUES(namespace)`;
      await sql`SELECT namespace FROM panda_force_creation_ledgers WHERE namespace=${this.namespace} FOR UPDATE`;
      return this.context.run(sql, work);
    });
  }
  async read<T>(work: () => Promise<T>) {
    if (this.context.getStore()) return work();
    return consistentMySQLRead(this.pool, (sql) => this.context.run(sql, work));
  }
}
