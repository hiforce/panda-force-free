import { documentKeyHash } from "./mysql-session.js";
import type { MySQLDocumentSession } from "./mysql-session.js";
import { randomUUID } from "node:crypto";
import type { DocumentFolder, DocumentRecord } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";
const beneath = (path: string, root: string) => path === root || path.startsWith(root + "/");
/** Folder mutations change logical locations only. The source filesystem and revision bodies are untouched. */
export class MySQLDocumentFolderRepository {
  constructor(private db: MySQLDocumentSession) {}
  async list(spaceId: string): Promise<DocumentFolder[]> {
    return await this.db.all<DocumentFolder>(
      "SELECT * FROM panda_force_document_folders WHERE spaceId=? ORDER BY path",
      [spaceId],
    );
  }
  async create(spaceId: string, path: string) {
    return await this.db.transaction(async () => {
      const existing = await this.list(spaceId),
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
        await this.db.run(
          "INSERT INTO panda_force_document_folders(id,spaceId,path,version,createdAt,updatedAt,pathHash) VALUES (?,?,?,1,?,?,?) ON DUPLICATE KEY UPDATE spaceId=spaceId",
          [randomUUID(), spaceId, current, now, now, documentKeyHash(current)],
        );
      }
      return (await this.db.one<DocumentFolder>(
        "SELECT * FROM panda_force_document_folders WHERE spaceId=? AND path=?",
        [spaceId, path],
      ))!;
    });
  }
  async move(spaceId: string, path: string, next: string, version: number) {
    return await this.db.transaction(async () => {
      const folders = await this.list(spaceId),
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
      const documents = await this.db.all<{
          id: string;
          path: string;
        }>("SELECT id,path FROM panda_force_documents WHERE spaceId=?", [spaceId]),
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
        await this.db.run(
          "UPDATE panda_force_document_folders SET path=?,pathHash=?,version=version+1,updatedAt=? WHERE id=?",
          [replacement(folder.path), documentKeyHash(replacement(folder.path)), Date.now(), folder.id],
        );
      for (const document of moved)
        await this.db.run("UPDATE panda_force_documents SET path=?,pathHash=?,updatedAt=? WHERE id=?", [
          replacement(document.path),
          documentKeyHash(replacement(document.path)),
          Date.now(),
          document.id,
        ]);
      const parent = next.split("/").slice(0, -1).join("/");
      if (parent) await this.create(spaceId, parent);
      return (await this.list(spaceId)).find((folder) => folder.id === current.id)!;
    });
  }
  async moveDocument(documentId: string, path: string, expected: number) {
    return await this.db.transaction(async () => {
      const document = await this.db.one<DocumentRecord>("SELECT * FROM panda_force_documents WHERE id=?", [
        documentId,
      ]);
      if (!document) throw new DocumentError("notFound", 404);
      if (document.revision !== expected) throw new DocumentError("conflict", 409);
      if (
        await this.db.one("SELECT id FROM panda_force_documents WHERE spaceId=? AND lower(path)=lower(?) AND id<>?", [
          document.spaceId,
          path,
          documentId,
        ])
      )
        throw new DocumentError("duplicate", 409);
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent) await this.create(document.spaceId, parent);
      await this.db.run("UPDATE panda_force_documents SET path=?,pathHash=?,updatedAt=? WHERE id=?", [
        path,
        documentKeyHash(path),
        Date.now(),
        documentId,
      ]);
    });
  }
  async trash(documentId: string, expected: number) {
    return await this.db.transaction(async () => {
      const document = await this.db.one<{
        revision: number;
      }>("SELECT revision FROM panda_force_documents WHERE id=?", [documentId]);
      if (!document) throw new DocumentError("notFound", 404);
      if (document.revision !== expected) throw new DocumentError("conflict", 409);
      await this.db.run(
        "INSERT INTO panda_force_document_trash VALUES (?,?) ON DUPLICATE KEY UPDATE documentId=documentId",
        [documentId, Date.now()],
      );
    });
  }
  async restore(document: DocumentRecord) {
    return await this.db.transaction(async () => {
      await this.db.run("DELETE FROM panda_force_document_trash WHERE documentId=?", [document.id]);
      const parent = document.path.split("/").slice(0, -1).join("/");
      if (parent) await this.create(document.spaceId, parent);
    });
  }
  async trashList(spaceId: string): Promise<DocumentRecord[]> {
    return await this.db.all<DocumentRecord>(
      "SELECT d.* FROM panda_force_documents d JOIN panda_force_document_trash t ON t.documentId=d.id WHERE d.spaceId=? ORDER BY t.deletedAt DESC LIMIT 200",
      [spaceId],
    );
  }
  async remove(spaceId: string, path: string, expected: number) {
    return await this.db.transaction(async () => {
      const folders = await this.list(spaceId),
        root = folders.find((folder) => folder.path === path);
      if (!root) throw new DocumentError("notFound", 404);
      if (root.version !== expected) throw new DocumentError("conflict", 409);
      const documents = (
        await this.db.all<DocumentRecord>("SELECT * FROM panda_force_documents WHERE spaceId=?", [spaceId])
      ).filter((document) => document.path.startsWith(path + "/"));
      for (const document of documents) await this.trash(document.id, document.revision);
      for (const folder of folders.filter((folder) => beneath(folder.path, path)))
        await this.db.run("DELETE FROM panda_force_document_folders WHERE id=?", [folder.id]);
      return { documents: documents.length };
    });
  }
}
