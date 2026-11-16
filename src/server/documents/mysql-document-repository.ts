import { documentKeyHash } from "./mysql-session.js";
import type { MySQLDocumentSession } from "./mysql-session.js";
import { mysqlRevisionResources, mysqlInsertRevisionResources } from "./mysql-revision-resources.js";
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
type DraftInput = {
  title: string;
  locale: string;
  content: string;
  body?: RichDocumentBody;
};
/** MySQL owns immutable revisions. External source files are never rewritten here. */
export class MySQLDocumentRepository {
  constructor(private db: MySQLDocumentSession) {}
  async record(id: string): Promise<DocumentRecord> {
    const document = await this.db.one<DocumentRecord>("SELECT * FROM panda_force_documents WHERE id=?", [id]);
    if (!document) throw new DocumentError("notFound", 404);
    return document;
  }
  async get(id: string): Promise<DocumentDetail> {
    return this.db.snapshot(async () => {
      const document = await this.record(id);
      const revision = await this.db.one<DocumentRevision>("SELECT * FROM panda_force_document_revisions WHERE id=?", [
        document.revisionId,
      ]);
      if (!revision) throw new DocumentError("notFound", 404);
      return {
        document,
        revision: {
          ...revision,
          ...(await this.richBody(revision.id)),
          resources: await mysqlRevisionResources(this.db, revision.id),
        },
      };
    });
  }
  async list(spaceId: string, search = "", offset = 0, limit = 50): Promise<DocumentPage> {
    return this.db.snapshot(async () => {
      const needle = search.trim().toLowerCase().slice(0, 200);
      const from =
        "FROM panda_force_documents WHERE spaceId=? AND id NOT IN (SELECT documentId FROM panda_force_document_trash) AND (?='' OR LOCATE(?,lower(title))>0 OR LOCATE(?,lower(path))>0)";
      const total = (await this.db.one<{
        count: number;
      }>("SELECT count(*) AS count " + from, [spaceId, needle, needle, needle]))!.count;
      const documents = await this.db.all<DocumentRecord>("SELECT * " + from + " ORDER BY path,id LIMIT ? OFFSET ?", [
        spaceId,
        needle,
        needle,
        needle,
        limit,
        offset,
      ]);
      return { documents, total, nextOffset: offset + documents.length < total ? offset + documents.length : null };
    });
  }
  async isTrashed(id: string) {
    return !!(await this.db.one("SELECT 1 FROM panda_force_document_trash WHERE documentId=?", [id]));
  }
  async revisions(id: string): Promise<Omit<DocumentRevision, "content">[]> {
    await this.get(id);
    return await this.db.all<Omit<DocumentRevision, "content">>(
      "SELECT id,documentId,number,title,locale,contentHash,createdAt FROM panda_force_document_revisions WHERE documentId=? ORDER BY number DESC LIMIT 100",
      [id],
    );
  }
  async revision(documentId: string, revisionId: string): Promise<DocumentRevision> {
    return this.db.snapshot(async () => {
      const revision = await this.db.one<DocumentRevision>(
        "SELECT * FROM panda_force_document_revisions WHERE documentId=? AND id=?",
        [documentId, revisionId],
      );
      if (!revision) throw new DocumentError("notFound", 404);
      return {
        ...revision,
        ...(await this.richBody(revision.id)),
        resources: await mysqlRevisionResources(this.db, revision.id),
      };
    });
  }
  private async richBody(revisionId: string): Promise<{
    body?: RichDocumentBody;
  }> {
    const row = await this.db.one<{
      body: string;
    }>("SELECT body FROM panda_force_document_rich_revisions WHERE revisionId=?", [revisionId]);
    return row ? { body: JSON.parse(row.body) as RichDocumentBody } : {};
  }
  private async insertRevision(documentId: string, number: number, input: DraftInput, id: string, now: number) {
    await this.db.run("INSERT INTO panda_force_document_revisions VALUES (?,?,?,?,?,?,?,?)", [
      id,
      documentId,
      number,
      input.title,
      input.locale,
      input.content,
      contentHash(input.content, input.body),
      now,
    ]);
    if (input.body) {
      for (const imageId of richBodyImageIds(input.body)) {
        const owned = await this.db.one<{
          documentId: string;
        }>("SELECT documentId FROM panda_force_document_assets WHERE id=?", [imageId]);
        if (owned?.documentId !== documentId) throw new DocumentError("invalidImage");
      }
      await this.db.run("INSERT INTO panda_force_document_rich_revisions VALUES (?,?)", [id, stableJson(input.body)]);
    }
  }
  async create(
    spaceId: string,
    path: string,
    input: DraftInput,
    importedHash: string | null = null,
  ): Promise<DocumentDetail> {
    return await this.db.transaction(async () => {
      if (await this.db.one("SELECT id FROM panda_force_documents WHERE spaceId=? AND path=?", [spaceId, path]))
        throw new DocumentError("duplicate", 409);
      const id = randomUUID(),
        revisionId = randomUUID(),
        now = Date.now();
      await this.db.run(
        "INSERT INTO panda_force_documents(id,spaceId,path,title,locale,revision,revisionId,contentHash,importedHash,importedRevision,updatedAt,pathHash) VALUES (?,?,?,?,?,1,?,?,?,?,?,?)",
        [
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
          documentKeyHash(path),
        ],
      );
      await this.insertRevision(id, 1, input, revisionId, now);
      return await this.get(id);
    });
  }
  async save(
    id: string,
    expected: number,
    input: DraftInput,
    importedHash?: string,
    resources?: DocumentResourceBinding[],
  ): Promise<DocumentDetail> {
    return await this.db.transaction(async () => {
      const { document } = await this.get(id);
      if (document.revision !== expected) throw new DocumentError("conflict", 409);
      const duplicateLocale = await this.db.one<{
        id: string;
      }>(
        "SELECT d.id FROM panda_force_document_languages own JOIN panda_force_document_languages peer ON peer.groupId=own.groupId JOIN panda_force_documents d ON d.id=peer.documentId WHERE own.documentId=? AND d.id<>? AND lower(d.locale)=lower(?) LIMIT 1",
        [id, id, input.locale],
      );
      if (duplicateLocale) throw new DocumentError("languageConflict", 409);
      const revisionId = randomUUID(),
        now = Date.now(),
        number = expected + 1;
      await this.insertRevision(id, number, input, revisionId, now);
      await mysqlInsertRevisionResources(
        this.db,
        id,
        revisionId,
        resources ?? (await mysqlRevisionResources(this.db, document.revisionId)),
      );
      await this.db.run(
        "UPDATE panda_force_documents SET title=?,locale=?,revision=?,revisionId=?,contentHash=?,importedHash=?,importedRevision=?,updatedAt=? WHERE id=?",
        [
          input.title,
          input.locale,
          number,
          revisionId,
          contentHash(input.content, input.body),
          importedHash ?? document.importedHash,
          importedHash ? number : document.importedRevision,
          now,
          id,
        ],
      );
      return await this.get(id);
    });
  }
  async import(
    spaceId: string,
    sources: SourceDocument[],
    complete = true,
  ): Promise<Omit<ImportResult, "skipped" | "truncated">> {
    return await this.db.transaction(async () => {
      const result = { created: 0, updated: 0, unchanged: 0, conflicts: [] as string[] };
      const sourcePaths = new Set(sources.map((source) => source.path));
      const missing = (
        await this.db.all<DocumentRecord>(
          "SELECT * FROM panda_force_documents WHERE spaceId=? AND importedHash IS NOT NULL",
          [spaceId],
        )
      ).filter((record) => !sourcePaths.has(record.path));
      const hashCounts = new Map<string, number>();
      for (const source of sources) hashCounts.set(source.hash, (hashCounts.get(source.hash) || 0) + 1);
      for (const source of sources) {
        let old = await this.db.one<DocumentRecord>("SELECT * FROM panda_force_documents WHERE spaceId=? AND path=?", [
          spaceId,
          source.path,
        ]);
        // Preserve identity for an unambiguous rename, including independently edited drafts.
        if (complete && !old && hashCounts.get(source.hash) === 1) {
          const matches = missing.filter((record) => record.importedHash === source.hash);
          if (matches.length === 1) {
            old = matches[0]!;
            await this.db.run("UPDATE panda_force_documents SET path=?,pathHash=? WHERE id=?", [
              source.path,
              documentKeyHash(source.path),
              old.id,
            ]);
            missing.splice(missing.indexOf(old), 1);
          }
        }
        if (!old) {
          await this.create(spaceId, source.path, source, source.hash);
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
        await this.save(old.id, old.revision, source, source.hash);
        result.updated++;
      }
      return result;
    });
  }
}
