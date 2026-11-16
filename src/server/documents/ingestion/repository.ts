import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DocumentDetail, SourceDocument, DocumentResourceBinding } from "../../../shared/documents/contracts.js";
import type { DocumentRepository } from "../document-repository.js";
import type { DocumentAssetRepository } from "../asset-repository.js";
import type { StagedImage } from "./images.js";
import { insertRevisionResources } from "../revision-resources.js";
import { DocumentError } from "../errors.js";

/** Commits source revisions and their staged resource ownership in one SQLite transaction. */
export class DocumentIngestionRepository {
  constructor(
    private db: Database,
    private documents: DocumentRepository,
    private assets: DocumentAssetRepository,
  ) {}
  private bindings(document: string, images: StagedImage[]) {
    const available = this.assets.list(document),
      resources: DocumentResourceBinding[] = [];
    let imported = 0;
    for (const image of images) {
      let asset = available.find((item) => item.digest === image.asset.digest && item.name === image.asset.name);
      if (!asset) {
        asset = this.assets.create({
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
  private apply(detail: DocumentDetail, images: StagedImage[], unpublishedRevision: boolean) {
    const { document, revision } = detail,
      { imported, resources } = this.bindings(document.id, images);
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
      this.db.query("DELETE FROM document_revision_assets WHERE revisionId=?").run(revision.id);
      insertRevisionResources(this.db, document.id, revision.id, resources);
      return { detail: this.documents.get(document.id), imported, changed: true };
    }
    const fresh = document.revision === document.importedRevision && document.importedHash === document.contentHash;
    return {
      detail: this.documents.save(
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
  import(
    space: string,
    sources: SourceDocument[],
    staged: ReadonlyMap<string, StagedImage[]>,
    complete: boolean,
    version?: number,
  ) {
    return this.db
      .transaction(() => {
        this.checkSpace(space, version);
        const previous = new Set(
          this.db
            .query<{ revisionId: string }, [string]>("SELECT revisionId FROM documents WHERE spaceId=?")
            .all(space)
            .map((row) => row.revisionId),
        );
        const result = this.documents.import(space, sources, complete);
        let imported = 0,
          updatedDocuments = 0;
        for (const source of sources) {
          const row = this.db
            .query<{ id: string }, [string, string]>("SELECT id FROM documents WHERE spaceId=? AND path=?")
            .get(space, source.path);
          if (!row) continue;
          const detail = this.documents.get(row.id),
            document = detail.document;
          if (document.revision !== document.importedRevision || document.importedHash !== source.hash) continue;
          const applied = this.apply(detail, staged.get(source.path) || [], !previous.has(document.revisionId));
          imported += applied.imported;
          if (applied.changed) updatedDocuments++;
        }
        return { ...result, assets: { imported, updatedDocuments } };
      })
      .immediate();
  }
  update(document: string, expected: number, images: StagedImage[], version?: number) {
    return this.db
      .transaction(() => {
        const detail = this.documents.get(document);
        this.checkSpace(detail.document.spaceId, version);
        if (detail.document.revision !== expected) throw new DocumentError("conflict", 409);
        return this.apply(detail, images, false);
      })
      .immediate();
  }
  private checkSpace(id: string, version?: number) {
    if (
      version !== undefined &&
      this.db.query<{ version: number }, [string]>("SELECT version FROM document_spaces WHERE id=?").get(id)
        ?.version !== version
    )
      throw new DocumentError("spaceConflict", 409);
  }
}
