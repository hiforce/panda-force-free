import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../../database/data-migration.js";
export const nativeThemesMigrationTables: readonly MigrationTable[] = [
  {
    source: "native_theme_audit",
    target: "panda_force_native_theme_audit",
    columns: ["sequence", "actor", "revision", "action", "id", "version", "digest", "createdAt"],
    sourceKeys: ["sequence"],
    targetKeys: ["sequence"],
    numericColumns: ["sequence", "revision", "createdAt"],
    project: (row) => [
      row.sequence,
      row.actor,
      row.revision,
      row.action,
      row.id,
      row.version,
      row.digest,
      row.createdAt,
    ],
  },
  {
    source: "native_theme_heads",
    target: "panda_force_native_theme_heads",
    columns: ["actor", "id", "version"],
    sourceKeys: ["actor", "id"],
    targetKeys: ["actor", "id"],
    numericColumns: [],
    project: (row) => [row.actor, row.id, row.version],
  },
  {
    source: "native_theme_operations",
    target: "panda_force_native_theme_operations",
    columns: [
      "actor",
      "operationId",
      "signature",
      "state",
      "expectedRevision",
      "descriptor",
      "digest",
      "settingsDigest",
      "receipt",
      "cleaned",
      "createdAt",
    ],
    sourceKeys: ["actor", "operationId"],
    targetKeys: ["actor", "operationId"],
    numericColumns: ["expectedRevision", "cleaned", "createdAt"],
    project: (row) => [
      row.actor,
      row.operationId,
      row.signature,
      row.state,
      row.expectedRevision,
      row.descriptor,
      row.digest,
      row.settingsDigest,
      row.receipt,
      row.cleaned,
      row.createdAt,
    ],
  },
  {
    source: "native_theme_owners",
    target: "panda_force_native_theme_owners",
    columns: ["actor", "revision"],
    sourceKeys: ["actor"],
    targetKeys: ["actor"],
    numericColumns: ["revision"],
    project: (row) => [row.actor, row.revision],
  },
  {
    source: "native_theme_versions",
    target: "panda_force_native_theme_versions",
    columns: ["actor", "id", "version", "digest", "descriptor", "sourceId", "enabled", "installedAt"],
    sourceKeys: ["actor", "id", "version"],
    targetKeys: ["actor", "id", "version"],
    numericColumns: ["enabled", "installedAt"],
    project: (row) => [
      row.actor,
      row.id,
      row.version,
      row.digest,
      row.descriptor,
      row.sourceId,
      row.enabled,
      row.installedAt,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migrateNativeThemesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "templates-native-theme",
    converterVersion: 1,
    tables: nativeThemesMigrationTables,
  });
}
