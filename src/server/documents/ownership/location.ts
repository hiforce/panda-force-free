import type { DocumentProjectReads } from "../files/projects.js";
import { readDocumentOwnership } from "../../project-content/ownership-file.js";
import { readFileTree } from "../files/navigation/read.js";
import { sqlOwnershipRecord } from "./record.js";
import { ownershipSQLTable, type OwnershipSQLBatch } from "./sql-batch.js";

/** Location reads never initialize a library, owner directory or creation worker. */
export async function fileOwnershipLocation(projects: DocumentProjectReads, project: string, documentId: string) {
  return (
    (await projects.ifPresent(project, async (_project, view) => ({
      active: (await readFileTree(view, project)).tree.nodes.some((node) => node.documentId === documentId),
      ownership: await readDocumentOwnership(view, documentId),
    }))) ?? { active: false, ownership: null }
  );
}

export async function sqlOwnershipLocation(db: OwnershipSQLBatch, project: string, documentId: string) {
  const table = (name: Parameters<typeof ownershipSQLTable>[1]) => ownershipSQLTable(db, name),
    [active, ownership] = await db.read([
      {
        sql: `SELECT n.documentId FROM ${table("document_tree_nodes")} n JOIN ${table("project_document_libraries")} l ON l.spaceId=n.spaceId JOIN ${table("documents")} d ON d.id=n.documentId AND d.spaceId=n.spaceId LEFT JOIN ${table("document_trash")} t ON t.documentId=d.id WHERE l.projectId=? AND n.documentId=? AND t.documentId IS NULL`,
        values: [project, documentId],
      },
      {
        sql: `SELECT o.record FROM ${table("document_ownership_records")} o JOIN ${table("project_document_libraries")} l ON l.spaceId=o.spaceId WHERE l.projectId=? AND o.documentId=?`,
        values: [project, documentId],
      },
    ]);
  return {
    active: active!.length === 1,
    ownership: ownership![0] ? sqlOwnershipRecord(String(ownership![0].record), documentId, project) : null,
  };
}
