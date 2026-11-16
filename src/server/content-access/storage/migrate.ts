import { migrateSQLiteModule, type MigrationTable } from "../../database/data-migration.js";
import { contentAccessMySQLModels } from "../../database/modules/content-access.js";
const tables: readonly MigrationTable[] = contentAccessMySQLModels.map((m) => ({
  source: m.name.slice("panda_force_".length),
  target: m.name,
  columns: m.columns.map((c) => c.name),
  sourceKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  targetKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
  project: (r) => m.columns.map((c) => r[c.name] ?? null),
}));
export const migrateContentAccessSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, module: "content-access", converterVersion: 1, tables });
