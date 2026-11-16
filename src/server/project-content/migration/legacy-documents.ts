import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type {
  DocumentDetail,
  DocumentRecord,
  DocumentRevision,
  DocumentResourceBinding,
} from "../../../shared/documents/contracts.js";
import { encodeProjectDocument } from "../document-file.js";
import { ProjectContentError } from "../errors.js";
import { projectContentId } from "../paths.js";
import { readLegacyProjectMetadata, type LegacyProjectMetadata } from "./legacy-metadata.js";
import type { ReadQueries } from "../../../shared/storage/read-queries.js";
import { migrationReadQueries } from "./read-snapshot.js";

async function fileHash(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new ProjectContentError("invalidFile");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export interface LegacyDocumentInventory {
  document: DocumentRecord;
  revisions: number;
  encodedBytes: number;
  historyHash: string;
}

/** Read only a standalone backup, holding one SQLite snapshot until the migration reader closes. */
export class LegacyProjectDocuments {
  private closed = false;
  private constructor(
    private readonly db: Database,
    private readonly path: string,
    readonly projectId: string,
    readonly sourceHash: string,
    readonly schema: number,
    private readonly rich: boolean,
    private readonly resources: boolean,
  ) {}

  static async open(path: string, projectId: string): Promise<LegacyProjectDocuments> {
    projectContentId(projectId);
    for (const suffix of ["-wal", "-journal"]) {
      try {
        await lstat(path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new ProjectContentError("invalidFile");
    }
    const hash = await fileHash(path),
      db = new Database(path, { readonly: true, strict: true });
    try {
      db.exec("BEGIN");
      const schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (schema < 1 || schema > 6) throw new ProjectContentError("unsupportedSchema");
      if (
        db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
        db.query("PRAGMA foreign_key_check").get()
      )
        throw new ProjectContentError("invalidFile");
      const tables = new Set(
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
      for (const name of [
        "document_spaces",
        "documents",
        "document_revisions",
        ...(schema >= 5 ? ["document_rich_revisions"] : []),
        ...(schema >= 3 ? ["document_revision_assets", "document_assets"] : []),
      ])
        if (!tables.has(name)) throw new ProjectContentError("invalidFile");
      return new LegacyProjectDocuments(
        db,
        path,
        projectId,
        hash,
        schema,
        tables.has("document_rich_revisions"),
        tables.has("document_revision_assets"),
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }

  records(): DocumentRecord[] {
    this.assertOpen();
    return this.db
      .query<DocumentRecord, [string]>(
        "SELECT d.* FROM documents d JOIN document_spaces s ON s.id=d.spaceId WHERE s.projectId=? ORDER BY d.id",
      )
      .all(this.projectId);
  }

  metadata(): LegacyProjectMetadata {
    this.assertOpen();
    return readLegacyProjectMetadata(this.db, this.projectId, this.schema, this.records());
  }

  *versions(record: DocumentRecord): Generator<DocumentDetail> {
    this.assertOpen();
    const owned = this.db
      .query<{ projectId: string }, [string]>("SELECT projectId FROM document_spaces WHERE id=?")
      .get(record.spaceId);
    if (owned?.projectId !== this.projectId) throw new ProjectContentError("unowned");
    let expected = 1,
      final = "";
    for (const row of this.db
      .query<DocumentRevision, [string]>("SELECT * FROM document_revisions WHERE documentId=? ORDER BY number")
      .iterate(record.id)) {
      if (row.number !== expected++ || row.documentId !== record.id) throw new ProjectContentError("invalidFile");
      const revision: DocumentRevision = { ...row };
      const body = this.rich
        ? this.db
            .query<{ body: string }, [string]>("SELECT body FROM document_rich_revisions WHERE revisionId=?")
            .get(row.id)
        : null;
      if (body) {
        try {
          revision.body = JSON.parse(body.body) as NonNullable<DocumentRevision["body"]>;
        } catch {
          throw new ProjectContentError("invalidFile");
        }
      }
      revision.resources = this.resources
        ? this.db
            .query<DocumentResourceBinding, [string]>(
              "SELECT r.source,r.sourcePath,r.assetId,a.digest FROM document_revision_assets r JOIN document_assets a ON a.id=r.assetId WHERE r.revisionId=? ORDER BY r.source",
            )
            .all(row.id)
        : [];
      const document: DocumentRecord =
        row.number === record.revision
          ? { ...record }
          : {
              ...record,
              title: row.title,
              locale: row.locale,
              revision: row.number,
              revisionId: row.id,
              contentHash: row.contentHash,
              importedHash: null,
              importedRevision: null,
              updatedAt: row.createdAt,
            };
      const detail = { document, revision };
      encodeProjectDocument(detail);
      final = row.id;
      yield detail;
    }
    if (expected !== record.revision + 1 || final !== record.revisionId) throw new ProjectContentError("invalidFile");
  }

  inventory(): LegacyDocumentInventory[] {
    return this.records().map((document) => {
      const hash = createHash("sha256");
      let revisions = 0,
        encodedBytes = 0;
      for (const detail of this.versions(document)) {
        const encoded = encodeProjectDocument(detail);
        hash.update(createHash("sha256").update(encoded).digest());
        encodedBytes += Buffer.byteLength(encoded);
        revisions++;
      }
      return { document, revisions, encodedBytes, historyHash: hash.digest("hex") };
    });
  }

  /** Migration participants inspect the same read-only snapshot without running application constructors. */
  inspect<T>(read: (queries: ReadQueries) => T): T {
    this.assertOpen();
    return read(migrationReadQueries(this.db, () => this.assertOpen()));
  }

  async assertSourceUnchanged(): Promise<void> {
    this.assertOpen();
    for (const suffix of ["-wal", "-journal"]) {
      try {
        if ((await lstat(this.path + suffix)).size > 0) throw new ProjectContentError("conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if ((await fileHash(this.path)) !== this.sourceHash) throw new ProjectContentError("conflict");
  }
  private assertOpen(): void {
    if (this.closed) throw new ProjectContentError("unavailable");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("ROLLBACK");
    } finally {
      this.db.close();
    }
  }
}
