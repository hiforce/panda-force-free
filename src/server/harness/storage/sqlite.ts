import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HarnessError } from "../../../shared/harness/contracts.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../ports.js";

/** Only metadata lives here. Awaited JSONL writes remain inside the same serialized metadata transaction. */
export class SQLiteHarnessMetadata implements HarnessMetadata {
  private readonly db: Database;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 1) {
      this.db.close();
      throw new HarnessError("unavailable", 503);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_records(
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS harness_records_owner_kind ON harness_records(owner,kind,updatedAt);
      PRAGMA user_version=1;`);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessError("unavailable", 503));
    const operation = this.tail.then(work, work);
    this.tail = operation.catch(() => {});
    return operation;
  }
  private transactionPort(): HarnessMetadataTransaction {
    const get = async (id: string) =>
      this.db.query<HarnessRecord, [string]>("SELECT * FROM harness_records WHERE id=?").get(id);
    return {
      get,
      list: async (kind, owner) =>
        owner === undefined
          ? this.db
              .query<HarnessRecord, [string]>("SELECT * FROM harness_records WHERE kind=? ORDER BY updatedAt DESC,id")
              .all(kind)
          : this.db
              .query<HarnessRecord, [string, string]>(
                "SELECT * FROM harness_records WHERE kind=? AND owner=? ORDER BY updatedAt DESC,id",
              )
              .all(kind, owner),
      put: async (row, expected) => {
        const current = await get(row.id);
        if ((current?.revision ?? null) !== expected || row.revision !== (expected ?? 0) + 1)
          throw new HarnessError("conflict", 409);
        this.db
          .query(
            "INSERT INTO harness_records VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,owner=excluded.owner,revision=excluded.revision,data=excluded.data,updatedAt=excluded.updatedAt",
          )
          .run(row.id, row.kind, row.owner, row.revision, row.data, row.updatedAt);
      },
      remove: async (id, expected) => {
        if ((await get(id))?.revision !== expected) throw new HarnessError("conflict", 409);
        this.db.query("DELETE FROM harness_records WHERE id=? AND revision=?").run(id, expected);
      },
    };
  }
  read(id: string) {
    return this.serialize(() => this.transactionPort().get(id));
  }
  list(kind: string, owner?: string) {
    return this.serialize(() => this.transactionPort().list(kind, owner));
  }
  transaction<T>(work: (transaction: HarnessMetadataTransaction) => Promise<T>) {
    return this.serialize(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = await work(this.transactionPort());
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async close() {
    this.closed = true;
    await this.tail;
    this.db.close();
  }
}
