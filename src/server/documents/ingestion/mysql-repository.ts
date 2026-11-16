import type { MySQLDocumentSession } from "../mysql-session.js";
import { randomUUID } from "node:crypto";
import type { DocumentDetail, SourceDocument, DocumentResourceBinding } from "../../../shared/documents/contracts.js";
import type { MySQLDocumentRepository } from "../mysql-document-repository.js";
import type { MySQLDocumentAssetRepository } from "../mysql-asset-repository.js";
import type { StagedImage } from "./images.js";
import { mysqlInsertRevisionResources } from "../mysql-revision-resources.js";
import { DocumentError } from "../errors.js";
/** Commits source revisions and their staged resource ownership in one MySQL transaction. */
export class MySQLDocumentIngestionRepository {
  constructor(
    private db: MySQLDocumentSession,
    private documents: MySQLDocumentRepository,
    private assets: MySQLDocumentAssetRepository,
  ) {}
  private async bindings(document: string, images: StagedImage[]) {
    const available = await this.assets.list(document),
      resources: DocumentResourceBinding[] = [];
    let imported = 0;
    for (const image of images) {
      let asset = available.find((item) => item.digest === image.asset.digest && item.name === image.asset.name);
      if (!asset) {
        asset = await this.assets.create({
          ...image.asset,
          id: randomUUID(),
          documentId: document,
          alt: "",
          createdAt: Date.now(),
        });
        available.push(asset);
        imported++;
      }
      resources.push({ source: image.source, sourcePath: image.sourcePath, assetId: asset.id, digest: asset.digest });
    }
    return { imported, resources: resources.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)) };
  }
  private async apply(detail: DocumentDetail, images: StagedImage[], unpublishedRevision: boolean) {
    const { document, revision } = detail,
      { imported, resources } = await this.bindings(document.id, images);
    if (
      (revision.resources || []).length === resources.length &&
      resources.every((item) =>
        revision.resources?.some(
          (old) =>
            old.source === item.source &&
            old.sourcePath === item.sourcePath &&
            old.assetId === item.assetId &&
            old.digest === item.digest,
        ),
      )
    )
      return { detail, imported, changed: false };
    if (unpublishedRevision) {
      // This revision was created earlier in the same transaction and has never been exposed to a reader.
      await this.db.run("DELETE FROM panda_force_document_revision_assets WHERE revisionId=?", [revision.id]);
      await mysqlInsertRevisionResources(this.db, document.id, revision.id, resources);
      return { detail: await this.documents.get(document.id), imported, changed: true };
    }
    const fresh = document.revision === document.importedRevision && document.importedHash === document.contentHash;
    return {
      detail: await this.documents.save(
        document.id,
        document.revision,
        revision,
        fresh ? document.importedHash! : undefined,
        resources,
      ),
      imported,
      changed: true,
    };
  }
  async import(
    space: string,
    sources: SourceDocument[],
    staged: ReadonlyMap<string, StagedImage[]>,
    complete: boolean,
    version?: number,
  ) {
    return await this.db.transaction(async () => {
      await this.checkSpace(space, version);
      const previous = new Set(
        (
          await this.db.all<{
            revisionId: string;
          }>("SELECT revisionId FROM panda_force_documents WHERE spaceId=?", [space])
        ).map((row) => row.revisionId),
      );
      const result = await this.documents.import(space, sources, complete);
      let imported = 0,
        updatedDocuments = 0;
      for (const source of sources) {
        const row = await this.db.one<{
          id: string;
        }>("SELECT id FROM panda_force_documents WHERE spaceId=? AND path=?", [space, source.path]);
        if (!row) continue;
        const detail = await this.documents.get(row.id),
          document = detail.document;
        if (document.revision !== document.importedRevision || document.importedHash !== source.hash) continue;
        const applied = await this.apply(detail, staged.get(source.path) || [], !previous.has(document.revisionId));
        imported += applied.imported;
        if (applied.changed) updatedDocuments++;
      }
      return { ...result, assets: { imported, updatedDocuments } };
    });
  }
  async update(document: string, expected: number, images: StagedImage[], version?: number) {
    return await this.db.transaction(async () => {
      const detail = await this.documents.get(document);
      await this.checkSpace(detail.document.spaceId, version);
      if (detail.document.revision !== expected) throw new DocumentError("conflict", 409);
      return await this.apply(detail, images, false);
    });
  }
  private async checkSpace(id: string, version?: number) {
    if (
      version !== undefined &&
      (
        await this.db.one<{
          version: number;
        }>("SELECT version FROM panda_force_document_spaces WHERE id=?", [id])
      )?.version !== version
    )
      throw new DocumentError("spaceConflict", 409);
  }
}
