import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import {
  migrateSQLiteModule,
  largeContentMigrationLimits,
  type MigrationTable,
  type MigrationProgress,
} from "../database/data-migration.js";
import { editorialMySQLModels } from "../database/modules/editorial.js";
const sources: readonly [string, readonly string[]][] = [
  ["editorial_proposals", ["id"]],
  ["editorial_applications", ["proposalId"]],
  ["editorial_history", ["id"]],
  ["editorial_jobs", ["id"]],
  ["editorial_job_retries", ["jobId", "retryId"]],
  ["editorial_application_intents", ["proposalId"]],
];
export const editorialSQLiteMappings: readonly MigrationTable[] = sources.map(([source, keys]) => {
  const model = editorialMySQLModels.find((m) => m.name === "panda_force_" + source)!,
    columns = model.columns.map((c) => c.name);
  return {
    source,
    target: model.name,
    columns,
    sourceKeys: keys,
    targetKeys: keys,
    numericColumns: model.columns.filter((c) => c.type === "bigint").map((c) => c.name),
    project: (r) => columns.map((c) => (c === "sequence" && source !== "editorial_history" ? r.__cursor! : r[c]!)),
  };
});
export function importEditorialSQLite(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if (source.query<{ version: number }, []>("SELECT version FROM editorial_schema WHERE id=1").get()?.version !== 4)
      throw Error("unsupportedEditorialMigrationSchema");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "editorial",
    converterVersion: 1,
    tables: editorialSQLiteMappings,
  });
}
