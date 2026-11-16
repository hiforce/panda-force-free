import { migrateSQLiteModule, type MigrationTable } from "../database/data-migration.js";
import { gadgetMySQLModels } from "../database/modules/gadgets.js";
const tables: readonly MigrationTable[] = gadgetMySQLModels
  .filter((m) => m.name !== "panda_force_gadget_workspace_controls")
  .map((m) => {
    const sequenced = m.columns.some((c) => c.name === "seq");
    return {
      source: m.name.slice("panda_force_".length),
      target: m.name,
      columns: m.columns.map((c) => c.name),
      sourceKeys: sequenced ? ["rowid"] : m.indexes.find((i) => i.name === "PRIMARY")!.columns,
      targetKeys: sequenced ? ["seq"] : m.indexes.find((i) => i.name === "PRIMARY")!.columns,
      numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
      project: (r) => m.columns.map((c) => (c.name === "seq" ? r.__cursor! : (r[c.name] ?? null))),
    };
  });
export const migrateGadgetSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => migrateSQLiteModule({ ...options, converterVersion: 1, module: "gadgets", tables });
