import { migrateSQLiteModule, type MigrationTable } from "../../database/data-migration.js";
import { cliMySQLModels } from "../../database/modules/cli-auth.js";
const tables: readonly MigrationTable[] = cliMySQLModels
  .filter((m) => m.name !== "panda_force_cli_control")
  .map((m) => ({
    source: m.name.slice("panda_force_".length),
    target: m.name,
    columns: m.columns.map((c) => c.name),
    sourceKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
    targetKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
    numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
    project: (r) => m.columns.map((c) => r[c.name] ?? null),
  }));
export const migrateCliSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, converterVersion: 1, module: "cli-auth", tables });
