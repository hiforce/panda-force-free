import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable, type MigrationValue } from "../../database/data-migration.js";
import { searchMySQLModels } from "../../database/modules/search.js";
/** Copies relational metadata only; descriptors and secrets remain byte-exact and no provider is contacted. */
export const searchMigrationTables: readonly MigrationTable[] = searchMySQLModels
  .filter((model) => model.name !== "panda_force_search_mutex")
  .map((model) => {
    const columns = model.columns.map((column) => column.name),
      numericColumns = model.columns.filter((column) => /int/.test(column.type)).map((column) => column.name),
      keys = model.indexes.find((index) => index.name === "PRIMARY")!.columns;
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
export async function migrateSearchSnapshot(
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if ((source.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 6)
      throw Error("unsupportedSearchSnapshotVersion");
    if (source.query("PRAGMA foreign_key_check").get()) throw Error("invalidSearchSnapshotReferences");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({ ...options, module: "search", converterVersion: 1, tables: searchMigrationTables });
}
