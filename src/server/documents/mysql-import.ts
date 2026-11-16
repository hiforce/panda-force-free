import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import {
  migrateSQLiteModule,
  largeContentMigrationLimits,
  type MigrationTable,
  type MigrationProgress,
} from "../database/data-migration.js";
import { documentMySQLModels } from "../database/modules/documents.js";
import { documentKeyHash } from "./mysql-session.js";
const sources: readonly [string, readonly string[], boolean?][] = [
  ["document_spaces", ["id"]],
  ["documents", ["id"]],
  ["document_revisions", ["id"]],
  ["document_assets", ["id"]],
  ["document_languages", ["documentId"]],
  ["document_revision_assets", ["revisionId", "source"]],
  ["document_site_profiles", ["spaceId"]],
  ["project_document_libraries", ["projectId"]],
  ["document_folders", ["id"]],
  ["document_trash", ["documentId"]],
  ["document_rich_revisions", ["revisionId"]],
  ["document_placements", ["id"]],
  ["document_placement_events", ["placementId", "version"]],
  ["document_tree_versions", ["spaceId"], true],
  ["document_tree_nodes", ["documentId"], true],
  ["document_tree_operations", ["id"], true],
  ["document_tree_trash", ["documentId"], true],
  ["document_tree_folder_origins", ["spaceId", "path"], true],
];
/** Explicit immutable v1 mappings preserve relational bodies, resource references and operation receipts. */
export const documentSQLiteMappings: readonly MigrationTable[] = sources.map(([source, keys, optional]) => {
  const model = documentMySQLModels.find((m) => m.name === "panda_force_" + source)!,
    columns = model.columns.map((c) => c.name);
  return {
    source,
    target: model.name,
    columns,
    sourceKeys: keys,
    targetKeys: keys,
    optional,
    numericColumns: model.columns.filter((c) => c.type === "bigint").map((c) => c.name),
    project: (r) =>
      columns.map((c) => {
        if (c === "pathHash") return documentKeyHash(String(r.path));
        if (c === "sourceHash") return documentKeyHash(String(r.source));
        if (c === "activePathHash") return r.deletedAt === null ? documentKeyHash(String(r.pathKey)) : null;
        if (c === "activeLocale") return r.deletedAt === null ? String(r.locale).toLowerCase() : null;
        return r[c]!;
      }),
  };
});
export function importDocumentsSQLite(options: {
  sql: SQL;
  snapshotPath: string;
  migrationId: string;
  progress?: (value: MigrationProgress) => void | Promise<void>;
}) {
  const source = new Database(options.snapshotPath, { readonly: true, strict: true });
  try {
    if (source.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 6)
      throw Error("unsupportedDocumentMigrationSchema");
  } finally {
    source.close();
  }
  return migrateSQLiteModule({
    ...options,
    limits: largeContentMigrationLimits,
    module: "documents",
    converterVersion: 1,
    tables: documentSQLiteMappings,
  });
}
