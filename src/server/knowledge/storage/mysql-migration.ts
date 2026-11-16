import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable, type MigrationValue } from "../../database/data-migration.js";
import { knowledgeMySQLModels } from "../../database/modules/knowledge.js";
/** Explicit frozen v1 column mapping. Task row identities remain stable for pagination across the cutover. */
export const knowledgeMigrationTables: readonly MigrationTable[] = knowledgeMySQLModels
  .filter((model) => model.name !== "panda_force_knowledge_mutex")
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
          const value = column === "rowSequence" ? row.__cursor : row[column];
          if (value === null || value === undefined) return null;
          if (!numericColumns.includes(column)) return value;
          const integer = Number(value);
          if (!Number.isSafeInteger(integer)) throw Error("migrationNumericOverflow");
          return integer;
        }),
    };
  });
export async function migrateKnowledgeSnapshot(
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if ((source.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 8)
      throw Error("unsupportedKnowledgeSnapshotVersion");
    if (source.query("PRAGMA foreign_key_check").get()) throw Error("invalidKnowledgeSnapshotReferences");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    module: "knowledge",
    converterVersion: 1,
    tables: knowledgeMigrationTables,
  });
}
