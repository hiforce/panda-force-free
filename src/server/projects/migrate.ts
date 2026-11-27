import { Database } from "bun:sqlite";
import { migrateSQLiteModule, type MigrationTable } from "../database/data-migration.js";
import { projectMySQLModels } from "../database/modules/projects.js";
import { projectPathHash } from "./mysql-catalog.js";
const tables: readonly MigrationTable[] = projectMySQLModels.map((m) => ({
  source: m.name.slice("panda_force_".length),
  target: m.name,
  columns: m.columns.map((c) => c.name),
  sourceKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  targetKeys: m.indexes.find((i) => i.name === "PRIMARY")!.columns,
  numericColumns: m.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
  optional: m.name === "panda_force_project_document_storage" || m.name === "panda_force_session_project_checkpoints",
  project: (r) => m.columns.map((c) => (c.name === "pathHash" ? projectPathHash(String(r.path)) : (r[c.name] ?? null))),
}));
export const migrateProjectsSnapshot = (
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion">,
) => {
  const snapshot = new Database(options.snapshotPath, { readonly: true, strict: true });
  let includesCheckpoints: boolean;
  try {
    includesCheckpoints = !!snapshot
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_project_checkpoints'")
      .get();
  } finally {
    snapshot.close();
  }
  return migrateSQLiteModule({
    ...options,
    converterVersion: includesCheckpoints ? 2 : 1,
    module: "projects",
    tables: includesCheckpoints ? tables : tables.filter(({ source }) => source !== "session_project_checkpoints"),
  });
};
