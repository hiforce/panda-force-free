import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../../database/data-migration.js";
export const portableTemplatesMigrationTables: readonly MigrationTable[] = [
  {
    source: "portable_template_audit",
    target: "panda_force_portable_template_audit",
    columns: ["sequence", "revision", "action", "id", "version", "digest", "actor", "createdAt"],
    sourceKeys: ["sequence"],
    targetKeys: ["sequence"],
    numericColumns: ["sequence", "revision", "createdAt"],
    project: (row) => [
      row.sequence,
      row.revision,
      row.action,
      row.id,
      row.version,
      row.digest,
      row.actor,
      row.createdAt,
    ],
  },
  {
    source: "portable_template_draft_images",
    target: "panda_force_portable_template_draft_images",
    columns: ["draft", "id", "bytes", "metadata"],
    sourceKeys: ["draft", "id"],
    targetKeys: ["draft", "id"],
    numericColumns: ["bytes"],
    project: (row) => [row.draft, row.id, row.bytes, row.metadata],
  },
  {
    source: "portable_template_draft_operations",
    target: "panda_force_portable_template_draft_operations",
    columns: ["owner", "operationId", "request", "receipt", "createdAt"],
    sourceKeys: ["owner", "operationId"],
    targetKeys: ["owner", "operationId"],
    numericColumns: ["createdAt"],
    project: (row) => [row.owner, row.operationId, row.request, row.receipt, row.createdAt],
  },
  {
    source: "portable_template_draft_revisions",
    target: "panda_force_portable_template_draft_revisions",
    columns: ["id", "revision", "digest"],
    sourceKeys: ["id", "revision"],
    targetKeys: ["id", "revision"],
    numericColumns: ["revision"],
    project: (row) => [row.id, row.revision, row.digest],
  },
  {
    source: "portable_template_drafts",
    target: "panda_force_portable_template_drafts",
    columns: ["id", "owner", "revision", "digest", "manifest", "createdAt", "updatedAt", "removed"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["revision", "createdAt", "updatedAt", "removed"],
    project: (row) => [
      row.id,
      row.owner,
      row.revision,
      row.digest,
      row.manifest,
      row.createdAt,
      row.updatedAt,
      row.removed,
    ],
  },
  {
    source: "portable_template_heads",
    target: "panda_force_portable_template_heads",
    columns: ["id", "version"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: [],
    project: (row) => [row.id, row.version],
  },
  {
    source: "portable_template_operations",
    target: "panda_force_portable_template_operations",
    columns: ["actor", "operationId", "request", "receipt", "createdAt"],
    sourceKeys: ["actor", "operationId"],
    targetKeys: ["actor", "operationId"],
    numericColumns: ["createdAt"],
    project: (row) => [row.actor, row.operationId, row.request, row.receipt, row.createdAt],
  },
  {
    source: "portable_template_registry",
    target: "panda_force_portable_template_registry",
    columns: ["id", "revision"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["id", "revision"],
    project: (row) => [row.id, row.revision],
  },
  {
    source: "portable_template_versions",
    target: "panda_force_portable_template_versions",
    columns: ["id", "version", "digest", "manifest", "origin", "enabled", "installedAt", "installedBy"],
    sourceKeys: ["id", "version"],
    targetKeys: ["id", "version"],
    numericColumns: ["enabled", "installedAt"],
    project: (row) => [
      row.id,
      row.version,
      row.digest,
      row.manifest,
      row.origin,
      row.enabled,
      row.installedAt,
      row.installedBy,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migratePortableTemplatesSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "templates-portable",
    converterVersion: 1,
    tables: portableTemplatesMigrationTables,
  });
}
