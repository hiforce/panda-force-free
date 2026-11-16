import type { Database } from "bun:sqlite";
import type { DocumentPlacement } from "../../shared/documents/placements.js";
import type { DocumentService } from "./service.js";
import type { DocumentPlacements } from "./placements/service.js";
import { DocumentError } from "./errors.js";
import { localeText } from "./validation.js";

import type { DocumentSpaceSnapshot, SpaceDocumentSelection } from "./snapshot-port.js";
export type { DocumentSpaceSnapshot, SpaceDocumentSelection } from "./snapshot-port.js";
export interface DocumentSpaceSnapshotPort {
  capture(spaceId: string, locale: string, limits: { documents: number; bytes: number }): DocumentSpaceSnapshot;
}

/** A single read transaction freezes references and selected revisions before asynchronous build work. */
export class DocumentSpaceSnapshots implements DocumentSpaceSnapshotPort {
  constructor(
    private db: Database,
    private service: DocumentService,
    private placements: DocumentPlacements,
  ) {}
  capture(spaceId: string, language: string, limits: { documents: number; bytes: number }): DocumentSpaceSnapshot {
    if (
      !Number.isSafeInteger(limits.documents) ||
      limits.documents < 1 ||
      !Number.isSafeInteger(limits.bytes) ||
      limits.bytes < 1
    )
      throw new DocumentError("invalidInput");
    const locale = localeText(language);
    return this.db.transaction(() => {
      const space = this.service.space(spaceId),
        own = this.service.documents.list(spaceId, "", 0, limits.documents + 1),
        references = this.placements.listForSpace(spaceId);
      if (own.total + references.length > limits.documents) throw new DocumentError("tooLarge", 413);
      const records = own.documents.filter((document) => document.locale.toLowerCase() === locale.toLowerCase()),
        selected = references.filter((placement) => placement.locale.toLowerCase() === locale.toLowerCase()),
        heads: { documentId: string; revisionId: string }[] = records.map((document) => ({
          documentId: document.id,
          revisionId: document.revisionId,
        }));
      for (const placement of selected) {
        const source = this.service.documents.record(placement.documentId);
        heads.push({ documentId: source.id, revisionId: placement.revisionId ?? source.revisionId });
      }
      // Count both rich JSON and its exchange Markdown in SQLite before materializing any revision bodies.
      let bytes = selected.reduce((sum, placement) => sum + Buffer.byteLength(JSON.stringify(placement.metadata)), 0);
      for (const head of heads) {
        const volume = this.db
          .query<{ bytes: number }, [string, string]>(
            "SELECT length(CAST(r.content AS BLOB))+coalesce(length(CAST(b.body AS BLOB)),0) AS bytes FROM document_revisions r LEFT JOIN document_rich_revisions b ON b.revisionId=r.id WHERE r.documentId=? AND r.id=?",
          )
          .get(head.documentId, head.revisionId);
        if (!volume) throw new DocumentError("placementSourceUnavailable", 409);
        bytes += volume.bytes;
        if (bytes > limits.bytes) throw new DocumentError("tooLarge", 413);
      }
      const documents: SpaceDocumentSelection[] = records.map((document) => ({
        document,
        revision: this.service.documents.revision(document.id, document.revisionId),
        engine: space.engine,
        path: document.path,
        locale: document.locale,
      }));
      for (const placement of selected) documents.push(this.selection(placement));
      const paths = new Set<string>();
      for (const selection of documents) {
        const path = selection.path.normalize("NFC").toLowerCase();
        if (paths.has(path)) throw new DocumentError("placementPathConflict", 409);
        paths.add(path);
      }
      documents.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.document.id.localeCompare(b.document.id, "en"),
      );
      return { space, documents };
    })();
  }
  private selection(placement: DocumentPlacement): SpaceDocumentSelection {
    try {
      const resolved = this.placements.resolve(placement);
      return {
        ...resolved,
        path: placement.path,
        locale: placement.locale,
        metadata: placement.metadata,
        placement: { id: placement.id, version: placement.version },
      };
    } catch (error) {
      if (error instanceof DocumentError && error.code === "notFound")
        throw new DocumentError("placementSourceUnavailable", 409);
      throw error;
    }
  }
}
