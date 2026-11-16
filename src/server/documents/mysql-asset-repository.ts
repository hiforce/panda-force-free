import type { MySQLDocumentSession } from "./mysql-session.js";
import type { DocumentAsset } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";
/** Asset metadata is independent of blob IO and the document revision repository. */
export class MySQLDocumentAssetRepository {
  constructor(private db: MySQLDocumentSession) {}
  async list(documentId: string) {
    return await this.db.all<DocumentAsset>(
      "SELECT * FROM panda_force_document_assets WHERE documentId=? ORDER BY createdAt,id",
      [documentId],
    );
  }
  async get(id: string) {
    const record = await this.db.one<DocumentAsset>("SELECT * FROM panda_force_document_assets WHERE id=?", [id]);
    if (!record) throw new DocumentError("notFound", 404);
    return record;
  }
  async create(asset: DocumentAsset) {
    await this.db.run("INSERT INTO panda_force_document_assets VALUES (?,?,?,?,?,?,?,?,?,?)", [
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
    ]);
    return asset;
  }
}
