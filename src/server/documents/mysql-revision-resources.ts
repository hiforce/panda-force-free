import { documentKeyHash } from "./mysql-session.js";
import type { MySQLDocumentSession } from "./mysql-session.js";
import type { DocumentResourceBinding } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";
export async function mysqlRevisionResources(
  db: MySQLDocumentSession,
  revision: string,
): Promise<DocumentResourceBinding[]> {
  return await db.all<DocumentResourceBinding>(
    `SELECT r.source,r.sourcePath,r.assetId,a.digest FROM panda_force_document_revision_assets r
    JOIN panda_force_document_assets a ON a.id=r.assetId WHERE r.revisionId=? ORDER BY r.source`,
    [revision],
  );
}
/** Called only within the transaction creating a revision, before it becomes observable. */
export async function mysqlInsertRevisionResources(
  db: MySQLDocumentSession,
  document: string,
  revision: string,
  bindings: DocumentResourceBinding[],
) {
  for (const item of bindings) {
    const asset = await db.one<{
      documentId: string;
      digest: string;
    }>("SELECT documentId,digest FROM panda_force_document_assets WHERE id=?", [item.assetId]);
    if (!asset || asset.documentId !== document || asset.digest !== item.digest)
      throw new DocumentError("invalidInput");
    await db.run(
      "INSERT INTO panda_force_document_revision_assets(revisionId,source,assetId,sourcePath,sourceHash) VALUES(?,?,?,?,?)",
      [revision, item.source, item.assetId, item.sourcePath, documentKeyHash(item.source)],
    );
  }
}
