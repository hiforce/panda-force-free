import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable, type MigrationValue } from "../../database/data-migration.js";
import { embeddingMySQLModels } from "../../database/modules/search-embeddings.js";
export const embeddingMigrationTables: readonly MigrationTable[] = embeddingMySQLModels
  .filter((m) => m.name !== "panda_force_embedding_mutex")
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
          const value = row[column];
          if (value === null || value === undefined) return null;
          if (!numericColumns.includes(column)) return value;
          const integer = Number(value);
          if (!Number.isSafeInteger(integer)) throw Error("migrationNumericOverflow");
          return integer;
        }),
    };
  });
/** Frozen usage snapshots retain uncertain charges and outstanding leases exactly; no model or cache file is read. */
export async function migrateEmbeddingSnapshot(
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if ((source.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 1)
      throw Error("unsupportedEmbeddingSnapshotVersion");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    module: "search-embeddings",
    converterVersion: 1,
    tables: embeddingMigrationTables,
  });
}
