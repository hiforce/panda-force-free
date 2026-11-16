import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../database/data-migration.js";
export const templatePreviewsMigrationTables: readonly MigrationTable[] = [
  {
    source: "template_previews",
    target: "panda_force_template_previews",
    columns: ["sequence", "id", "owner", "cacheKey", "record", "phase", "token", "until"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["sequence", "until"],
    project(row) {
      const value = JSON.parse(String(row.record));
      if (!["queued", "building", "rendering", "ready", "failed"].includes(value.phase))
        throw new Error("invalidTemplatePreviewSnapshot");
      return [row.__cursor!, row.id!, row.owner!, row.cacheKey!, row.record!, value.phase, row.token!, row.until!];
    },
  },
];
/** The caller fences writers and supplies the frozen snapshot; raster image references remain unchanged. */
export function migrateTemplatePreviewsSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    module: "templates-previews",
    converterVersion: 1,
    limits: largeContentMigrationLimits,
    tables: templatePreviewsMigrationTables,
  });
}
