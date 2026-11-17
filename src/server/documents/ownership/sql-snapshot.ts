import type { DocumentAsset, DocumentRecord, DocumentSpace } from "../../../shared/documents/contracts.js";
import type { DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import type { DocumentHistorySummary } from "../history-page.js";
import type { DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import { sqlOwnershipRecord } from "./record.js";
import {
  ownershipSQLTable,
  type OwnershipSQLBatch,
  type OwnershipSQLCheck,
  type OwnershipSQLStatement,
} from "./sql-batch.js";

export interface SQLOwnershipSnapshot {
  space: DocumentSpace | null;
  version: number | null;
  tree: DocumentTreePlacement[];
  documents: DocumentRecord[];
  assets: DocumentAsset[];
  ownership: { spaceId: string; record: DocumentOwnershipRecord }[];
  trash: { documentId: string; deletedAt: number }[];
  tombstones: (DocumentTreePlacement & { spaceId: string; operationId: string })[];
  revisions: DocumentHistorySummary[];
  checks: OwnershipSQLCheck[];
}
export async function sqlOwnershipSnapshot(
  db: OwnershipSQLBatch,
  projectId: string,
  ids: string[],
): Promise<SQLOwnershipSnapshot> {
  ids = [...ids].sort((a, b) => a.localeCompare(b, "en"));
  const table = (name: Parameters<typeof ownershipSQLTable>[1]) => ownershipSQLTable(db, name),
    selected = ids.map(() => "?").join(",") || "NULL",
    queries: OwnershipSQLStatement[] = [
      {
        sql: `SELECT s.* FROM ${table("document_spaces")} s JOIN ${table("project_document_libraries")} l ON l.spaceId=s.id WHERE l.projectId=?`,
        values: [projectId],
      },
      {
        sql: `SELECT v.version FROM ${table("document_tree_versions")} v JOIN ${table("project_document_libraries")} l ON l.spaceId=v.spaceId WHERE l.projectId=?`,
        values: [projectId],
      },
      {
        sql: `SELECT n.documentId,n.parentId,n.position FROM ${table("document_tree_nodes")} n JOIN ${table("project_document_libraries")} l ON l.spaceId=n.spaceId WHERE l.projectId=? ORDER BY n.documentId`,
        values: [projectId],
      },
      { sql: `SELECT * FROM ${table("documents")} WHERE id IN (${selected}) ORDER BY id`, values: ids },
      { sql: `SELECT * FROM ${table("document_assets")} WHERE documentId IN (${selected}) ORDER BY id`, values: ids },
      {
        sql: `SELECT o.spaceId,o.record,o.documentId,s.projectId FROM ${table("document_ownership_records")} o JOIN ${table("document_spaces")} s ON s.id=o.spaceId WHERE o.documentId IN (${selected}) ORDER BY o.spaceId,o.documentId`,
        values: ids,
      },
      {
        sql: `SELECT documentId,deletedAt FROM ${table("document_trash")} WHERE documentId IN (${selected}) ORDER BY documentId`,
        values: ids,
      },
      {
        sql: `SELECT * FROM ${table("document_tree_trash")} WHERE documentId IN (${selected}) ORDER BY documentId`,
        values: ids,
      },
      {
        sql: `SELECT id,documentId,number,title,locale,contentHash,createdAt FROM ${table("document_revisions")} WHERE documentId IN (${selected}) ORDER BY documentId,number DESC`,
        values: ids,
      },
    ],
    rows = await db.read(queries),
    [spaces, versions, tree, documents, assets, ownership, trash, tombstones, revisions] = rows;
  return {
    space: (spaces![0] as unknown as DocumentSpace) ?? null,
    version: (versions![0]?.version as number) ?? null,
    tree: tree as unknown as DocumentTreePlacement[],
    documents: documents as unknown as DocumentRecord[],
    assets: assets as unknown as DocumentAsset[],
    ownership: ownership!.map((row) => ({
      spaceId: String(row.spaceId),
      record: sqlOwnershipRecord(String(row.record), String(row.documentId), String(row.projectId)),
    })),
    trash: trash as unknown as SQLOwnershipSnapshot["trash"],
    tombstones: tombstones as unknown as SQLOwnershipSnapshot["tombstones"],
    revisions: revisions as unknown as DocumentHistorySummary[],
    checks: queries.map((query, i) => ({ ...query, rows: rows[i]! })),
  };
}
