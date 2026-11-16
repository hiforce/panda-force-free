import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable, type MigrationValue } from "../../database/data-migration.js";
import { connectionMySQLModels } from "../../database/modules/connections.js";
import { publicationTargetHash } from "./target-hash.js";
/** Full paths remain byte-exact; a fixed digest permits a complete unique index without truncating administrator destinations. */
export const connectionMigrationTables: readonly MigrationTable[] = connectionMySQLModels
  .filter((m) => m.name !== "panda_force_publication_mutex")
  .map((model) => {
    const columns = model.columns.map((c) => c.name),
      numericColumns = model.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
      keys = model.indexes.find((i) => i.name === "PRIMARY")!.columns;
    return {
      source: model.name.slice("panda_force_".length),
      target: model.name,
      columns,
      sourceKeys: keys,
      targetKeys: keys,
      numericColumns,
      project: (row) =>
        columns.map((column): MigrationValue => {
          if (column === "targetPathHash") {
            if (typeof row.targetPath !== "string") throw Error("invalidMigrationRecord");
            return publicationTargetHash(row.targetPath);
          }
          const value = column === "rowSequence" ? row.__cursor : row[column];
          if (value === null || value === undefined) return null;
          if (!numericColumns.includes(column)) return value;
          const integer = Number(value);
          if (!Number.isSafeInteger(integer)) throw Error("migrationNumericOverflow");
          return integer;
        }),
    };
  });
/** Imports only a frozen source database snapshot. Neither ciphertext nor master-key material is decrypted or rewritten. */
export async function migrateConnectionSnapshot(
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    for (const [table, version] of [
      ["publication_connection_schema", 1],
      ["publication_credential_schema", 2],
      ["publication_account_schema", 1],
      ["publication_oauth_schema", 1],
    ] as const) {
      const row = source
        .query<
          {
            version: number;
          },
          []
        >(`SELECT version FROM ${table} WHERE id=1`)
        .get();
      if (row?.version !== version) throw Error("unsupportedConnectionSnapshotVersion");
    }
    if (source.query("PRAGMA foreign_key_check").get()) throw Error("invalidPublicationSnapshotReferences");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    module: "connections",
    converterVersion: 1,
    tables: connectionMigrationTables,
  });
}
