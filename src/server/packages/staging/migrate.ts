import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../../database/data-migration.js";
export const packageSourcesMigrationTables: readonly MigrationTable[] = [
  {
    source: "package_source_stage_events",
    target: "panda_force_package_source_stage_events",
    columns: ["id", "revision", "state", "at", "digest", "failure"],
    sourceKeys: ["id", "revision"],
    targetKeys: ["id", "revision"],
    numericColumns: ["revision", "at"],
    project: (row) => [row.id, row.revision, row.state, row.at, row.digest, row.failure],
  },
  {
    source: "package_source_stages",
    target: "panda_force_package_source_stages",
    columns: [
      "id",
      "actor",
      "operationId",
      "purpose",
      "request",
      "limits",
      "fingerprint",
      "revision",
      "state",
      "reservedBytes",
      "digest",
      "origin",
      "failure",
      "token",
      "expiresAt",
      "createdAt",
      "updatedAt",
      "entryPolicy",
    ],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["revision", "reservedBytes", "expiresAt", "createdAt", "updatedAt"],
    project: (row) => [
      row.id,
      row.actor,
      row.operationId,
      row.purpose,
      row.request,
      row.limits,
      row.fingerprint,
      row.revision,
      row.state,
      row.reservedBytes,
      row.digest,
      row.origin,
      row.failure,
      row.token,
      row.expiresAt,
      row.createdAt,
      row.updatedAt,
      row.entryPolicy,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migratePackageSourcesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "package-sources",
    converterVersion: 1,
    tables: packageSourcesMigrationTables,
  });
}

/** Owned native sources have separate ledgers and migration receipts, matching their file namespaces. */
export function migrateNativeThemeSourcesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "package-sources-native-theme",
    converterVersion: 1,
    tables: packageSourcesMigrationTables.map((table) => ({
      ...table,
      target: table.target.replace("panda_force_package_", "panda_force_native_theme_"),
    })),
  });
}
export function migrateNativeSlidesSourcesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "package-sources-native-slides",
    converterVersion: 1,
    tables: packageSourcesMigrationTables.map((table) => ({
      ...table,
      target: table.target.replace("panda_force_package_", "panda_force_native_slides_"),
    })),
  });
}
