import { mysqlOwnershipVisible } from "../ownership/sql-policy.js";
import { documentKeyHash } from "../mysql-session.js";
import type { MySQLDocumentSession } from "../mysql-session.js";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type {
  DocumentTreePlacement,
  DocumentTreeReceipt,
  DocumentTreeTrashItem,
} from "../../../shared/documents/navigation.js";
import { validateDocumentTree } from "../../../shared/documents/navigation.js";
import { DocumentError } from "../errors.js";
import { MySQLDocumentOwnershipRepository } from "../ownership/mysql-repository.js";
import { assertOwnershipVisible } from "../ownership/record.js";
export interface DocumentTreeRow extends DocumentTreePlacement {
  document: DocumentRecord;
  trashed: boolean;
}
export interface DocumentTreeTombstone extends DocumentTreePlacement {
  operationId: string;
}
/** This repository owns navigation metadata only. It never reads or rewrites source/revision bodies. */
export class MySQLDocumentNavigationRepository {
  constructor(private db: MySQLDocumentSession) {}
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
  async version(spaceId: string): Promise<number | null> {
    return (
      (
        await this.db.one<{
          version: number;
        }>("SELECT version FROM panda_force_document_tree_versions WHERE spaceId=?", [spaceId])
      )?.version ?? null
    );
  }
  async initialize(spaceId: string, placements: DocumentTreePlacement[]) {
    return await this.transaction(async () => {
      if ((await this.version(spaceId)) !== null) return false;
      validateDocumentTree(placements);
      await this.db.run("INSERT INTO panda_force_document_tree_versions VALUES(?,?)", [
        spaceId,
        placements.length ? 1 : 0,
      ]);
      for (const node of placements) await this.insert(spaceId, node);
      return true;
    });
  }
  async insert(spaceId: string, node: DocumentTreePlacement) {
    const result = await this.db.run(
      "INSERT INTO panda_force_document_tree_nodes(documentId,spaceId,parentId,position) SELECT id,spaceId,?,? FROM panda_force_documents WHERE id=? AND spaceId=?",
      [node.parentId, node.position, node.documentId, spaceId],
    );
    if (result.changes !== 1) throw new DocumentError("notFound", 404);
  }
  async rows(spaceId: string): Promise<DocumentTreeRow[]> {
    const rows = await this.db.all<
      DocumentRecord & {
        parentId: string | null;
        position: number;
        trashed: number;
      }
    >(
      `SELECT d.*,n.parentId,n.position,EXISTS(SELECT 1 FROM panda_force_document_trash t WHERE t.documentId=d.id) AS trashed FROM panda_force_document_tree_nodes n JOIN panda_force_documents d ON d.id=n.documentId AND d.spaceId=n.spaceId WHERE n.spaceId=? ORDER BY n.position,n.documentId`,
      [spaceId],
    );
    return rows.map(({ parentId, position, trashed, ...document }) => ({
      documentId: document.id,
      parentId,
      position,
      document,
      trashed: !!trashed,
    }));
  }
  async unregistered(spaceId: string): Promise<DocumentRecord[]> {
    return await this.db.all<DocumentRecord>(
      "SELECT d.* FROM panda_force_documents d LEFT JOIN panda_force_document_tree_nodes n ON n.documentId=d.id WHERE d.spaceId=? AND n.documentId IS NULL AND NOT EXISTS(SELECT 1 FROM panda_force_document_trash t WHERE t.documentId=d.id) ORDER BY d.path,d.id LIMIT 5001",
      [spaceId],
    );
  }
  async origins(spaceId: string) {
    return new Map(
      (
        await this.db.all<{
          path: string;
          documentId: string;
        }>("SELECT path,documentId FROM panda_force_document_tree_folder_origins WHERE spaceId=?", [spaceId])
      ).map((row) => [row.path, row.documentId]),
    );
  }
  async origin(spaceId: string, path: string, documentId: string) {
    await this.db.run(
      "INSERT INTO panda_force_document_tree_folder_origins(spaceId,path,documentId,pathHash) VALUES(?,?,?,?)",
      [spaceId, path, documentId, documentKeyHash(path)],
    );
  }
  async bump(spaceId: string, expected: number) {
    if (
      (
        await this.db.run(
          "UPDATE panda_force_document_tree_versions SET version=version+1 WHERE spaceId=? AND version=?",
          [spaceId, expected],
        )
      ).changes !== 1
    )
      throw new DocumentError("navigationConflict", 409);
  }
  async replace(spaceId: string, placements: DocumentTreePlacement[]) {
    await this.transaction(async () => {
      validateDocumentTree(placements);
      const current = new Map(
        (
          await this.db.all<DocumentTreePlacement>(
            "SELECT documentId,parentId,position FROM panda_force_document_tree_nodes WHERE spaceId=?",
            [spaceId],
          )
        ).map((node) => [node.documentId, node]),
      );
      if (current.size !== placements.length || placements.some((node) => !current.has(node.documentId)))
        throw new DocumentError("invalidInput");
      const update = this.db.statement(
        "UPDATE panda_force_document_tree_nodes SET parentId=?,position=? WHERE documentId=? AND spaceId=?",
      );
      for (const node of placements) {
        const previous = current.get(node.documentId)!;
        if (previous.parentId !== node.parentId || previous.position !== node.position)
          await update.run(node.parentId, node.position, node.documentId, spaceId);
      }
    });
  }
  async operation(spaceId: string, owner: string, id: string, request: string): Promise<string | null> {
    return (await this.operationRecord(spaceId, owner, id, request))?.documentId ?? null;
  }
  private async operationRecord(spaceId: string, owner: string, id: string, request: string) {
    const row = await this.db.one<{
      spaceId: string;
      owner: string;
      request: string;
      documentId: string;
      result: string | null;
    }>("SELECT spaceId,owner,request,documentId,result FROM panda_force_document_tree_operations WHERE id=?", [id]);
    if (!row) return null;
    if (row.spaceId !== spaceId || row.owner !== owner) throw new DocumentError("notFound", 404);
    if (row.request !== request) throw new DocumentError("conflict", 409);
    return row;
  }
  async receipt(spaceId: string, owner: string, id: string, request: string): Promise<DocumentTreeReceipt | null> {
    const row = await this.operationRecord(spaceId, owner, id, request);
    if (!row) return null;
    // Legacy metadata proves identity only; it cannot reconstruct a complete application receipt.
    if (!row.result) throw new DocumentError("navigationConflict", 409);
    try {
      const receipt = JSON.parse(row.result) as DocumentTreeReceipt;
      if (
        !receipt ||
        receipt.id !== id ||
        receipt.documentId !== row.documentId ||
        !Array.isArray(receipt.affectedDocumentIds) ||
        !receipt.affectedDocumentIds.length ||
        receipt.affectedDocumentIds.length > 5000 ||
        receipt.affectedDocumentIds.some((value) => typeof value !== "string" || !value || value.length > 128) ||
        new Set(receipt.affectedDocumentIds).size !== receipt.affectedDocumentIds.length ||
        !receipt.affectedDocumentIds.includes(row.documentId) ||
        !Number.isSafeInteger(receipt.treeVersion) ||
        receipt.treeVersion < 0 ||
        typeof receipt.restoredToRoot !== "boolean"
      )
        throw new Error("Invalid navigation receipt");
      return receipt;
    } catch {
      throw new DocumentError("sourceUnavailable", 503);
    }
  }
  async recordOperation(
    spaceId: string,
    owner: string,
    id: string,
    request: string,
    documentId: string,
    result?: DocumentTreeReceipt,
  ) {
    await this.db.run(
      "INSERT INTO panda_force_document_tree_operations(id,spaceId,owner,request,documentId,createdAt,result) VALUES(?,?,?,?,?,?,?)",
      [id, spaceId, owner, request, documentId, Date.now(), result ? JSON.stringify(result) : null],
    );
  }
  async tombstones(spaceId: string, operationId: string): Promise<DocumentTreeTombstone[]> {
    return await this.db.all<DocumentTreeTombstone>(
      "SELECT documentId,parentId,position,operationId FROM panda_force_document_tree_trash WHERE spaceId=? AND operationId=? LIMIT 5001",
      [spaceId, operationId],
    );
  }
  async tombstone(spaceId: string, documentId: string): Promise<DocumentTreeTombstone | null> {
    return await this.db.one<DocumentTreeTombstone>(
      "SELECT documentId,parentId,position,operationId FROM panda_force_document_tree_trash WHERE spaceId=? AND documentId=?",
      [spaceId, documentId],
    );
  }
  async forgetTombstones(ids: string[]) {
    const remove = this.db.statement("DELETE FROM panda_force_document_tree_trash WHERE documentId=?");
    for (const id of ids) await remove.run(id);
  }
  async retire(spaceId: string, ids: string[], operationId: string) {
    const snapshot = this.db.statement(
        "INSERT INTO panda_force_document_tree_trash(documentId,spaceId,parentId,position,operationId) SELECT documentId,spaceId,parentId,position,? FROM panda_force_document_tree_nodes WHERE documentId=? AND spaceId=? ON DUPLICATE KEY UPDATE parentId=VALUES(parentId),position=VALUES(position),operationId=VALUES(operationId)",
      ),
      trash = this.db.statement(
        "INSERT INTO panda_force_document_trash VALUES(?,?) ON DUPLICATE KEY UPDATE documentId=documentId",
      ),
      remove = this.db.statement("DELETE FROM panda_force_document_tree_nodes WHERE documentId=? AND spaceId=?");
    for (const id of ids) {
      if ((await snapshot.run(operationId, id, spaceId)).changes !== 1) throw new DocumentError("notFound", 404);
      await trash.run(id, Date.now());
      await remove.run(id, spaceId);
    }
  }
  async revive(ids: string[]) {
    const remove = this.db.statement("DELETE FROM panda_force_document_trash WHERE documentId=?");
    for (const id of ids) {
      assertOwnershipVisible(await new MySQLDocumentOwnershipRepository(this.db).forDocument(id));
      await remove.run(id);
    }
    await this.forgetTombstones(ids);
  }
  async trashList(spaceId: string): Promise<DocumentTreeTrashItem[]> {
    return (await this.trashPage(spaceId, null)).documents;
  }
  async trashPage(
    spaceId: string,
    after: {
      deletedAt: number;
      documentId: string;
    } | null,
  ) {
    const roots = await this.db.all<
      DocumentRecord & {
        deletedAt: number;
        operationId: string | null;
      }
    >(
      `SELECT d.*,x.deletedAt,t.operationId FROM panda_force_documents d JOIN panda_force_document_trash x ON x.documentId=d.id LEFT JOIN panda_force_document_tree_trash t ON t.documentId=d.id WHERE d.spaceId=? AND ${mysqlOwnershipVisible("d")} AND (t.documentId IS NULL OR NOT EXISTS(SELECT 1 FROM panda_force_document_tree_trash p JOIN panda_force_document_trash z ON z.documentId=p.documentId WHERE p.documentId=t.parentId AND p.operationId=t.operationId AND p.spaceId=t.spaceId)) AND (? IS NULL OR x.deletedAt<? OR (x.deletedAt=? AND d.id>?)) ORDER BY x.deletedAt DESC,d.id LIMIT 201`,
      [spaceId, after?.deletedAt ?? null, after?.deletedAt ?? null, after?.deletedAt ?? null, after?.documentId ?? ""],
    );
    const page = roots.slice(0, 200),
      branches = page.filter((row) => row.operationId).map((row) => row.id),
      counts = new Map(
        (branches.length
          ? await this.db.all<{ rootId: string; count: number }>(
              `WITH RECURSIVE branch(rootId,documentId,operationId,depth) AS (
                SELECT t.documentId,t.documentId,t.operationId,1 FROM panda_force_document_tree_trash t
                WHERE t.spaceId=? AND t.documentId IN (${branches.map(() => "?").join(",")})
                UNION ALL SELECT b.rootId,t.documentId,b.operationId,b.depth+1
                FROM panda_force_document_tree_trash t JOIN branch b ON t.parentId=b.documentId AND t.operationId=b.operationId
                JOIN panda_force_document_trash x ON x.documentId=t.documentId WHERE t.spaceId=? AND b.depth<32
              ) SELECT rootId,COUNT(*) AS count FROM branch GROUP BY rootId`,
              [spaceId, ...branches, spaceId],
            )
          : []
        ).map((row) => [row.rootId, Number(row.count)]),
      );
    const documents = page.map(({ deletedAt, operationId, ...document }) => ({
      document,
      deletedAt,
      subtreeCount: operationId ? (counts.get(document.id) ?? 1) : 1,
    }));
    const last = documents.at(-1);
    return {
      documents,
      nextCursor:
        roots.length > 200 && last
          ? Buffer.from(JSON.stringify({ deletedAt: last.deletedAt, documentId: last.document.id })).toString(
              "base64url",
            )
          : null,
    };
  }
}
