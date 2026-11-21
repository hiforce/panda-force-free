import { migrateSQLiteModule, type MigrationTable } from "../../database/data-migration.js";
export const harnessMigrationTables: readonly MigrationTable[] = [
  {
    source: "harness_records",
    target: "panda_force_harness_records",
    columns: ["id", "kind", "owner", "revision", "data", "updatedAt"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["revision", "updatedAt"],
    project: (row) => [row.id, row.kind, row.owner, row.revision, row.data, row.updatedAt],
  },
];
export const migrateHarnessSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, converterVersion: 1, module: "harness", tables: harnessMigrationTables });
