import type { Database } from "bun:sqlite";
import type { DocumentAsset } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

/** Asset metadata is independent of blob IO and the document revision repository. */
export class DocumentAssetRepository {
  constructor(private db: Database) {}
  list(documentId: string) {
    return this.db
      .query<DocumentAsset, [string]>("SELECT * FROM document_assets WHERE documentId=? ORDER BY createdAt,id")
      .all(documentId);
  }
  get(id: string) {
    const record = this.db.query<DocumentAsset, [string]>("SELECT * FROM document_assets WHERE id=?").get(id);
    if (!record) throw new DocumentError("notFound", 404);
    return record;
  }
  create(asset: DocumentAsset) {
    this.db
      .query("INSERT INTO document_assets VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        asset.id,
        asset.documentId,
        asset.name,
        asset.mime,
        asset.digest,
        asset.size,
        asset.width,
        asset.height,
        asset.alt,
        asset.createdAt,
      );
    return asset;
  }
}
