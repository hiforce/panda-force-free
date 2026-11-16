import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../database/data-migration.js";
export const siteBuildsMigrationTables: readonly MigrationTable[] = [
  {
    source: "site_build_resource_inputs",
    target: "panda_force_site_build_resource_inputs",
    columns: ["id", "owner", "ready", "reservedBytes"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["ready", "reservedBytes"],
    project: (row) => [row.id, row.owner, row.ready, row.reservedBytes],
  },
  {
    source: "site_builds",
    target: "panda_force_site_builds",
    columns: [
      "id",
      "spaceId",
      "request",
      "record",
      "input",
      "logs",
      "createdAt",
      "terminal",
      "projectId",
      "removed",
      "sequence",
    ],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["createdAt", "terminal", "removed", "sequence"],
    project: (row) => [
      row.id,
      row.spaceId,
      row.request,
      row.record,
      row.input,
      row.logs,
      row.createdAt,
      row.terminal,
      row.projectId,
      row.removed,
      row.__cursor,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migrateSiteBuildsSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "builds-sites",
    converterVersion: 1,
    tables: siteBuildsMigrationTables,
  });
}
