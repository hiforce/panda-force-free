import { revisionResources, insertRevisionResources } from "./revision-resources.js";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  DocumentDetail,
  DocumentRecord,
  DocumentRevision,
  DocumentPage,
  SourceDocument,
  ImportResult,
  DocumentResourceBinding,
} from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

import { contentHash } from "./content-hash.js";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import { richBodyImageIds } from "../../shared/documents/rich-body.js";
import { stableJson } from "../../shared/stable-json.js";
import { documentHistoryPage, documentHistoryCursor, type DocumentHistorySummary } from "./history-page.js";
import { DocumentOwnershipRepository } from "./ownership/repository.js";
type DraftInput = { title: string; locale: string; content: string; body?: RichDocumentBody };
/** SQLite owns immutable revisions. External source files are never rewritten here. */
export class DocumentRepository {
  constructor(private db: Database) {}
  record(id: string): DocumentRecord {
    const document = this.db.query<DocumentRecord, [string]>("SELECT * FROM documents WHERE id=?").get(id);
    if (!document) throw new DocumentError("notFound", 404);
    return document;
  }
  get(id: string): DocumentDetail {
    const document = this.record(id);
    const revision = this.db
      .query<DocumentRevision, [string]>("SELECT * FROM document_revisions WHERE id=?")
      .get(document.revisionId);
    if (!revision) throw new DocumentError("notFound", 404);
    return {
      document,
      revision: { ...revision, ...this.richBody(revision.id), resources: revisionResources(this.db, revision.id) },
    };
  }
  list(spaceId: string, search = "", offset = 0, limit = 50): DocumentPage {
    const needle = search.trim().toLowerCase().slice(0, 200);
    const from =
      "FROM documents WHERE spaceId=? AND id NOT IN (SELECT documentId FROM document_trash) AND (?='' OR instr(lower(title),?)>0 OR instr(lower(path),?)>0)";
    const total = this.db
      .query<{ count: number }, [string, string, string, string]>("SELECT count(*) AS count " + from)
      .get(spaceId, needle, needle, needle)!.count;
    const documents = this.db
      .query<DocumentRecord, [string, string, string, string, number, number]>(
        "SELECT * " + from + " ORDER BY path,id LIMIT ? OFFSET ?",
      )
      .all(spaceId, needle, needle, needle, limit, offset);
    return { documents, total, nextOffset: offset + documents.length < total ? offset + documents.length : null };
  }
  isTrashed(id: string) {
    const ownership = new DocumentOwnershipRepository(this.db).forDocument(id);
    if (ownership && ownership.kind !== "active") return true;
    return !!this.db.query("SELECT 1 FROM document_trash WHERE documentId=?").get(id);
  }
  revisions(id: string): Omit<DocumentRevision, "content">[] {
    this.get(id);
    return this.db
      .query<Omit<DocumentRevision, "content">, [string]>(
        "SELECT id,documentId,number,title,locale,contentHash,createdAt FROM document_revisions WHERE documentId=? ORDER BY number DESC LIMIT 100",
      )
      .all(id);
  }
  revision(documentId: string, revisionId: string): DocumentRevision {
    const revision = this.db
      .query<DocumentRevision, [string, string]>("SELECT * FROM document_revisions WHERE documentId=? AND id=?")
      .get(documentId, revisionId);
    if (!revision) throw new DocumentError("notFound", 404);
    return { ...revision, ...this.richBody(revision.id), resources: revisionResources(this.db, revision.id) };
  }
  /** A frozen exclusive version boundary lets transfers read every revision while later saves continue. */
  historyPage(id: string, beforeVersion: number, limit = 100) {
    documentHistoryPage(beforeVersion, limit);
    return this.db
      .transaction(() => {
        if (beforeVersion > this.record(id).revision + 1) throw new DocumentError("conflict", 409);
        const revisions = this.db
          .query<DocumentHistorySummary, [string, number, number]>(
            "SELECT id,documentId,number,title,locale,contentHash,createdAt FROM document_revisions WHERE documentId=? AND number<? ORDER BY number DESC LIMIT ?",
          )
          .all(id, beforeVersion, limit);
        return { revisions, nextBeforeVersion: documentHistoryCursor(revisions, limit) };
      })
      .deferred();
  }
  private richBody(revisionId: string): { body?: RichDocumentBody } {
    const row = this.db
      .query<{ body: string }, [string]>("SELECT body FROM document_rich_revisions WHERE revisionId=?")
      .get(revisionId);
    return row ? { body: JSON.parse(row.body) as RichDocumentBody } : {};
  }
  private insertRevision(documentId: string, number: number, input: DraftInput, id: string, now: number) {
    this.db
      .query("INSERT INTO document_revisions VALUES (?,?,?,?,?,?,?,?)")
      .run(
        id,
        documentId,
        number,
        input.title,
        input.locale,
        input.content,
        contentHash(input.content, input.body),
        now,
      );
    if (input.body) {
      for (const imageId of richBodyImageIds(input.body)) {
        const owned = this.db
          .query<{ documentId: string }, [string]>("SELECT documentId FROM document_assets WHERE id=?")
          .get(imageId);
        if (owned?.documentId !== documentId) throw new DocumentError("invalidImage");
      }
      this.db.query("INSERT INTO document_rich_revisions VALUES (?,?)").run(id, stableJson(input.body));
    }
  }
  create(spaceId: string, path: string, input: DraftInput, importedHash: string | null = null): DocumentDetail {
    return this.db
      .transaction(() => {
        if (this.db.query("SELECT id FROM documents WHERE spaceId=? AND path=?").get(spaceId, path))
          throw new DocumentError("duplicate", 409);
        const id = randomUUID(),
          revisionId = randomUUID(),
          now = Date.now();
        this.db
          .query("INSERT INTO documents VALUES (?,?,?,?,?,1,?,?,?,?,?)")
          .run(
            id,
            spaceId,
            path,
            input.title,
            input.locale,
            revisionId,
            contentHash(input.content, input.body),
            importedHash,
            importedHash ? 1 : null,
            now,
          );
        this.insertRevision(id, 1, input, revisionId, now);
        return this.get(id);
      })
      .immediate();
  }
  save(
    id: string,
    expected: number,
    input: DraftInput,
    importedHash?: string,
    resources?: DocumentResourceBinding[],
  ): DocumentDetail {
    return this.db
      .transaction(() => {
        const { document } = this.get(id);
        if (document.revision !== expected) throw new DocumentError("conflict", 409);
        const duplicateLocale = this.db
          .query<{ id: string }, [string, string, string]>(
            "SELECT d.id FROM document_languages own JOIN document_languages peer ON peer.groupId=own.groupId JOIN documents d ON d.id=peer.documentId WHERE own.documentId=? AND d.id<>? AND lower(d.locale)=lower(?) LIMIT 1",
          )
          .get(id, id, input.locale);
        if (duplicateLocale) throw new DocumentError("languageConflict", 409);
        const revisionId = randomUUID(),
          now = Date.now(),
          number = expected + 1;
        this.insertRevision(id, number, input, revisionId, now);
        insertRevisionResources(this.db, id, revisionId, resources ?? revisionResources(this.db, document.revisionId));
        this.db
          .query(
            "UPDATE documents SET title=?,locale=?,revision=?,revisionId=?,contentHash=?,importedHash=?,importedRevision=?,updatedAt=? WHERE id=?",
          )
          .run(
            input.title,
            input.locale,
            number,
            revisionId,
            contentHash(input.content, input.body),
            importedHash ?? document.importedHash,
            importedHash ? number : document.importedRevision,
            now,
            id,
          );
        return this.get(id);
      })
      .immediate();
  }
  import(spaceId: string, sources: SourceDocument[], complete = true): Omit<ImportResult, "skipped" | "truncated"> {
    return this.db
      .transaction(() => {
        const result = { created: 0, updated: 0, unchanged: 0, conflicts: [] as string[] };
        const sourcePaths = new Set(sources.map((source) => source.path));
        const missing = this.db
          .query<DocumentRecord, [string]>("SELECT * FROM documents WHERE spaceId=? AND importedHash IS NOT NULL")
          .all(spaceId)
          .filter((record) => !sourcePaths.has(record.path));
        const hashCounts = new Map<string, number>();
        for (const source of sources) hashCounts.set(source.hash, (hashCounts.get(source.hash) || 0) + 1);
        for (const source of sources) {
          let old = this.db
            .query<DocumentRecord, [string, string]>("SELECT * FROM documents WHERE spaceId=? AND path=?")
            .get(spaceId, source.path);
          // Preserve identity for an unambiguous rename, including independently edited drafts.
          if (complete && !old && hashCounts.get(source.hash) === 1) {
            const matches = missing.filter((record) => record.importedHash === source.hash);
            if (matches.length === 1) {
              old = matches[0]!;
              this.db.query("UPDATE documents SET path=? WHERE id=?").run(source.path, old.id);
              missing.splice(missing.indexOf(old), 1);
            }
          }
          if (!old) {
            this.create(spaceId, source.path, source, source.hash);
            result.created++;
            continue;
          }
          if (old.importedHash === source.hash) {
            result.unchanged++;
            continue;
          }
          // A source refresh must not overwrite a browser draft or a locally created document.
          if (!old.importedHash || old.revision !== old.importedRevision) {
            result.conflicts.push(source.path);
            continue;
          }
          this.save(old.id, old.revision, source, source.hash);
          result.updated++;
        }
        return result;
      })
      .immediate();
  }
}
