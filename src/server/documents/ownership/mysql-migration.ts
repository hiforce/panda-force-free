import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable, type MigrationProgress } from "../../database/data-migration.js";
import { sqlOwnershipRecord } from "./record.js";

/** A separate conversion phase preserves shipped document-v1 mapping hashes and its already recorded receipts. */
export const documentOwnershipSQLiteMappings: readonly MigrationTable[] = [
  {
    source: "document_ownership_records",
    target: "panda_force_document_ownership_records",
    columns: ["spaceId", "documentId", "record"],
    sourceKeys: ["spaceId", "documentId"],
    targetKeys: ["spaceId", "documentId"],
    optional: true,
    project: (row) => [row.spaceId!, row.documentId!, row.record!],
  },
];
export async function importDocumentOwnershipSQLite(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if (source.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 6)
      throw Error("unsupportedDocumentMigrationSchema");
    const exists = source
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_ownership_records'")
      .get();
    if (exists)
      for (const row of source
        .query<{ record: string; documentId: string; projectId: string }, []>(
          "SELECT o.record,o.documentId,s.projectId FROM document_ownership_records o JOIN document_spaces s ON s.id=o.spaceId",
        )
        .all())
        sqlOwnershipRecord(row.record, row.documentId, row.projectId);
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    module: "document-ownership",
    converterVersion: 1,
    tables: documentOwnershipSQLiteMappings,
  });
}
