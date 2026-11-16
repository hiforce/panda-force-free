import type { SQL } from "bun";
import {
  largeContentMigrationLimits,
  migrateSQLiteModule,
  type MigrationTable,
  type MigrationProgress,
} from "../database/data-migration.js";
export const publishingMigrationTables: readonly MigrationTable[] = [
  {
    source: "publication_reviews",
    target: "panda_force_publication_reviews",
    columns: ["id", "variantId", "payload", "reviewedAt"],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["id", "reviewedAt"],
    project: (row) => [row.id, row.variantId, row.payload, row.reviewedAt],
  },
  {
    source: "publication_variants",
    target: "panda_force_publication_variants",
    columns: [
      "id",
      "documentId",
      "revisionId",
      "payload",
      "digest",
      "review",
      "createdAt",
      "sourceSnapshot",
      "sourceProjectId",
      "summary",
      "summaryDigest",
      "referenceDigest",
      "sequence",
    ],
    sourceKeys: ["id"],
    targetKeys: ["id"],
    numericColumns: ["createdAt", "sequence"],
    project: (row) => [
      row.id,
      row.documentId,
      row.revisionId,
      row.payload,
      row.digest,
      row.review,
      row.createdAt,
      row.sourceSnapshot,
      row.sourceProjectId,
      row.summary,
      row.summaryDigest,
      row.referenceDigest,
      row.__cursor,
    ],
  },
];
/** The caller fences writers and supplies the frozen snapshot; file/object references remain unchanged. */
export function migratePublishingSnapshot(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "publishing",
    converterVersion: 1,
    tables: publishingMigrationTables,
  });
}
