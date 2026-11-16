import type { Database } from "bun:sqlite";
import type { DocumentResourceBinding } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

export function revisionResources(db: Database, revision: string): DocumentResourceBinding[] {
  return db
    .query<DocumentResourceBinding, [string]>(
      `SELECT r.source,r.sourcePath,r.assetId,a.digest FROM document_revision_assets r
    JOIN document_assets a ON a.id=r.assetId WHERE r.revisionId=? ORDER BY r.source`,
    )
    .all(revision);
}
/** Called only within the transaction creating a revision, before it becomes observable. */
export function insertRevisionResources(
  db: Database,
  document: string,
  revision: string,
  bindings: DocumentResourceBinding[],
) {
  for (const item of bindings) {
    const asset = db
      .query<{ documentId: string; digest: string }, [string]>(
        "SELECT documentId,digest FROM document_assets WHERE id=?",
      )
      .get(item.assetId);
    if (!asset || asset.documentId !== document || asset.digest !== item.digest)
      throw new DocumentError("invalidInput");
    db.query("INSERT INTO document_revision_assets(revisionId,source,assetId,sourcePath) VALUES(?,?,?,?)").run(
      revision,
      item.source,
      item.assetId,
      item.sourcePath,
    );
  }
}
