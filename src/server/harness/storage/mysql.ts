import type { SQL } from "bun";
import { mysqlInteger } from "../../database/mysql-model.js";
import { HarnessError } from "../../../shared/harness/contracts.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord, HarnessRecordList } from "../ports.js";

/** A database guard fences metadata and the corresponding committed JSONL offsets across application processes. */
export class MySQLHarnessMetadata implements HarnessMetadata {
  constructor(private readonly pool: SQL) {}
  private port(sql: SQL): HarnessMetadataTransaction {
    const record = (row: HarnessRecord): HarnessRecord => ({
      ...row,
      revision: mysqlInteger(row.revision),
      updatedAt: mysqlInteger(row.updatedAt),
    });
    const get = async (id: string) => {
      const rows = await sql`SELECT * FROM panda_force_harness_records WHERE id=${id}`;
      return rows[0] ? record(rows[0] as HarnessRecord) : null;
    };
    return {
      get,
      list: async (kind, owner, page) => {
        const owned = owner === undefined ? sql`` : sql`AND owner=${owner}`;
        const due = page?.updatedThrough === undefined ? sql`` : sql`AND updatedAt<=${page.updatedThrough}`;
        const order = page?.oldestFirst ? sql`ASC` : sql`DESC`;
        const limit = page ? sql`LIMIT ${page.limit}` : sql``;
        const rows =
          await sql`SELECT * FROM panda_force_harness_records WHERE kind=${kind} ${owned} ${due} ORDER BY updatedAt ${order},id ${limit}`;
        return rows.map(record);
      },
      put: async (row, expected) => {
        if ((await get(row.id))?.revision !== (expected ?? undefined) || row.revision !== (expected ?? 0) + 1)
          throw new HarnessError("conflict", 409);
        await sql`INSERT INTO panda_force_harness_records(id,kind,owner,revision,data,updatedAt) VALUES(${row.id},${row.kind},${row.owner},${row.revision},${row.data},${row.updatedAt}) ON DUPLICATE KEY UPDATE kind=VALUES(kind),owner=VALUES(owner),revision=VALUES(revision),data=VALUES(data),updatedAt=VALUES(updatedAt)`;
      },
      remove: async (id, expected) => {
        if ((await get(id))?.revision !== expected) throw new HarnessError("conflict", 409);
        await sql`DELETE FROM panda_force_harness_records WHERE id=${id} AND revision=${expected}`;
      },
    };
  }
  read(id: string) {
    return this.port(this.pool).get(id);
  }
  list(kind: string, owner?: string, page?: HarnessRecordList) {
    return this.port(this.pool).list(kind, owner, page);
  }
  transaction<T>(work: (transaction: HarnessMetadataTransaction) => Promise<T>) {
    return this.pool.begin(async (sql) => {
      await sql`INSERT INTO panda_force_harness_guard(id) VALUES(1) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
      await sql`SELECT id FROM panda_force_harness_guard WHERE id=1 FOR UPDATE`;
      return work(this.port(sql));
    });
  }
  close() {}
}
