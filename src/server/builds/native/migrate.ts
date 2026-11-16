import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../../database/data-migration.js";
export const nativeSamplesMigrationTables: readonly MigrationTable[] = [
  {
    source: "native_sample_runs",
    target: "panda_force_native_sample_runs",
    columns: [
      "id",
      "owner",
      "signature",
      "sampleKey",
      "record",
      "inputReady",
      "terminal",
      "reservedBytes",
      "removed",
      "logs",
      "sequence",
    ],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["inputReady", "terminal", "reservedBytes", "removed", "sequence"],
    project: (row) => [
      row.id,
      row.owner,
      row.signature,
      row.sampleKey,
      row.record,
      row.inputReady,
      row.terminal,
      row.reservedBytes,
      row.removed,
      row.logs,
      row.__cursor,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migrateNativeSamplesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "builds-native-samples",
    converterVersion: 1,
    tables: nativeSamplesMigrationTables,
  });
}
