import type { Database } from "bun:sqlite";
import type { MySQLDocumentSession } from "../mysql-session.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../errors.js";

export interface OwnershipSQLStatement {
  sql: string;
  values: (string | number | null)[];
}
export interface OwnershipSQLCheck extends OwnershipSQLStatement {
  rows: Record<string, unknown>[];
}
/** SQL, table names and checks are produced by owned adapters, never by a serialized transfer or model input. */
export interface OwnershipSQLBatch {
  readonly mysql: boolean;
  read(queries: OwnershipSQLStatement[]): Promise<Record<string, unknown>[][]>;
  commit(checks: OwnershipSQLCheck[], changes: OwnershipSQLStatement[]): Promise<void>;
}
export function sqliteOwnershipBatch(db: Database): OwnershipSQLBatch {
  const read = ({ sql, values }: OwnershipSQLStatement) => db.query(sql).all(...values) as Record<string, unknown>[];
  return {
    mysql: false,
    read: async (queries) => db.transaction(() => queries.map(read)).deferred(),
    commit: async (checks, changes) =>
      db
        .transaction(() => {
          for (const check of checks)
            if (stableJson(read(check)) !== stableJson(check.rows)) throw new DocumentError("conflict", 409);
          for (const change of changes) db.query(change.sql).run(...change.values);
        })
        .immediate(),
  };
}
export function mysqlOwnershipBatch(db: MySQLDocumentSession): OwnershipSQLBatch {
  const read = ({ sql, values }: OwnershipSQLStatement) => db.all<Record<string, unknown>>(sql, values);
  return {
    mysql: true,
    read: (queries) =>
      db.snapshot(async () => {
        const result: Record<string, unknown>[][] = [];
        for (const query of queries) result.push(await read(query));
        return result;
      }),
    commit: (checks, changes) =>
      db.transaction(async () => {
        for (const check of checks)
          if (stableJson(await read(check)) !== stableJson(check.rows)) throw new DocumentError("conflict", 409);
        for (const change of changes) await db.run(change.sql, change.values);
      }),
  };
}
export type OwnershipSQLTable =
  | "documents"
  | "document_spaces"
  | "project_document_libraries"
  | "document_assets"
  | "document_revisions"
  | "document_rich_revisions"
  | "document_revision_assets"
  | "document_trash"
  | "document_tree_nodes"
  | "document_tree_versions"
  | "document_tree_operations"
  | "document_tree_trash"
  | "document_ownership_records";
export const ownershipSQLTable = (db: OwnershipSQLBatch, name: OwnershipSQLTable) =>
  (db.mysql ? "panda_force_" : "") + name;
export const ownershipSQLInsert = (
  db: OwnershipSQLBatch,
  name: OwnershipSQLTable,
  value: Record<string, string | number | null>,
): OwnershipSQLStatement => {
  const columns = Object.keys(value);
  return {
    sql: `INSERT INTO ${ownershipSQLTable(db, name)}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    values: Object.values(value),
  };
};
