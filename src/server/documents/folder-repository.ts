import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DocumentFolder, DocumentRecord } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

const beneath = (path: string, root: string) => path === root || path.startsWith(root + "/");
/** Folder mutations change logical locations only. The source filesystem and revision bodies are untouched. */
export class DocumentFolderRepository {
  constructor(private db: Database) {}
  list(spaceId: string): DocumentFolder[] {
    return this.db
      .query<DocumentFolder, [string]>("SELECT * FROM document_folders WHERE spaceId=? ORDER BY path")
      .all(spaceId);
  }
  create(spaceId: string, path: string) {
    return this.db
      .transaction(() => {
        const existing = this.list(spaceId),
          parts = path.split("/");
        const missing = parts
          .map((_, index) => parts.slice(0, index + 1).join("/"))
          .filter((path) => !existing.some((folder) => folder.path === path));
        if (existing.length + missing.length > 1000) throw new DocumentError("tooManyFolders", 409);
        const now = Date.now();
        for (let index = 1; index <= parts.length; index++) {
          const current = parts.slice(0, index).join("/");
          if (
            existing.some(
              (folder) =>
                folder.path.normalize("NFC").toLowerCase() === current.normalize("NFC").toLowerCase() &&
                folder.path !== current,
            )
          )
            throw new DocumentError("duplicate", 409);
          this.db
            .query("INSERT INTO document_folders VALUES (?,?,?,1,?,?) ON CONFLICT(spaceId,path) DO NOTHING")
            .run(randomUUID(), spaceId, current, now, now);
        }
        return this.db
          .query<DocumentFolder, [string, string]>("SELECT * FROM document_folders WHERE spaceId=? AND path=?")
          .get(spaceId, path)!;
      })
      .immediate();
  }
  move(spaceId: string, path: string, next: string, version: number) {
    return this.db
      .transaction(() => {
        const folders = this.list(spaceId),
          current = folders.find((folder) => folder.path === path);
        if (!current) throw new DocumentError("notFound", 404);
        if (current.version !== version) throw new DocumentError("conflict", 409);
        if (path === next) return current;
        if (beneath(next, path)) throw new DocumentError("invalidInput");
        const moving = folders.filter((folder) => beneath(folder.path, path)),
          outside = folders.filter((folder) => !beneath(folder.path, path));
        const replacement = (value: string) => next + value.slice(path.length);
        if (
          moving.some((folder) =>
            outside.some(
              (other) =>
                other.path.normalize("NFC").toLowerCase() === replacement(folder.path).normalize("NFC").toLowerCase(),
            ),
          )
        )
          throw new DocumentError("duplicate", 409);
        const documents = this.db
            .query<{ id: string; path: string }, [string]>("SELECT id,path FROM documents WHERE spaceId=?")
            .all(spaceId),
          moved = documents.filter((document) => document.path.startsWith(path + "/"));
        if (
          moved.some((document) =>
            documents.some(
              (other) =>
                !other.path.startsWith(path + "/") &&
                other.path.normalize("NFC").toLowerCase() === replacement(document.path).normalize("NFC").toLowerCase(),
            ),
          )
        )
          throw new DocumentError("duplicate", 409);
        for (const folder of moving)
          this.db
            .query("UPDATE document_folders SET path=?,version=version+1,updatedAt=? WHERE id=?")
            .run(replacement(folder.path), Date.now(), folder.id);
        for (const document of moved)
          this.db
            .query("UPDATE documents SET path=?,updatedAt=? WHERE id=?")
            .run(replacement(document.path), Date.now(), document.id);
        const parent = next.split("/").slice(0, -1).join("/");
        if (parent) this.create(spaceId, parent);
        return this.list(spaceId).find((folder) => folder.id === current.id)!;
      })
      .immediate();
  }
  moveDocument(documentId: string, path: string, expected: number) {
    return this.db
      .transaction(() => {
        const document = this.db.query<DocumentRecord, [string]>("SELECT * FROM documents WHERE id=?").get(documentId);
        if (!document) throw new DocumentError("notFound", 404);
        if (document.revision !== expected) throw new DocumentError("conflict", 409);
        if (
          this.db
            .query("SELECT id FROM documents WHERE spaceId=? AND lower(path)=lower(?) AND id<>?")
            .get(document.spaceId, path, documentId)
        )
          throw new DocumentError("duplicate", 409);
        const parent = path.split("/").slice(0, -1).join("/");
        if (parent) this.create(document.spaceId, parent);
        this.db.query("UPDATE documents SET path=?,updatedAt=? WHERE id=?").run(path, Date.now(), documentId);
      })
      .immediate();
  }
  trash(documentId: string, expected: number) {
    return this.db
      .transaction(() => {
        const document = this.db
          .query<{ revision: number }, [string]>("SELECT revision FROM documents WHERE id=?")
          .get(documentId);
        if (!document) throw new DocumentError("notFound", 404);
        if (document.revision !== expected) throw new DocumentError("conflict", 409);
        this.db
          .query("INSERT INTO document_trash VALUES (?,?) ON CONFLICT(documentId) DO NOTHING")
          .run(documentId, Date.now());
      })
      .immediate();
  }
  restore(document: DocumentRecord) {
    return this.db
      .transaction(() => {
        this.db.query("DELETE FROM document_trash WHERE documentId=?").run(document.id);
        const parent = document.path.split("/").slice(0, -1).join("/");
        if (parent) this.create(document.spaceId, parent);
      })
      .immediate();
  }
  trashList(spaceId: string): DocumentRecord[] {
    return this.db
      .query<DocumentRecord, [string]>(
        "SELECT d.* FROM documents d JOIN document_trash t ON t.documentId=d.id WHERE d.spaceId=? ORDER BY t.deletedAt DESC LIMIT 200",
      )
      .all(spaceId);
  }
  remove(spaceId: string, path: string, expected: number) {
    return this.db
      .transaction(() => {
        const folders = this.list(spaceId),
          root = folders.find((folder) => folder.path === path);
        if (!root) throw new DocumentError("notFound", 404);
        if (root.version !== expected) throw new DocumentError("conflict", 409);
        const documents = this.db
          .query<DocumentRecord, [string]>("SELECT * FROM documents WHERE spaceId=?")
          .all(spaceId)
          .filter((document) => document.path.startsWith(path + "/"));
        for (const document of documents) this.trash(document.id, document.revision);
        for (const folder of folders.filter((folder) => beneath(folder.path, path)))
          this.db.query("DELETE FROM document_folders WHERE id=?").run(folder.id);
        return { documents: documents.length };
      })
      .immediate();
  }
}
