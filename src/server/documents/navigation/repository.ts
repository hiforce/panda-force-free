import { sqliteOwnershipVisible } from "../ownership/sql-policy.js";
import type { Database } from "bun:sqlite";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type {
  DocumentTreePlacement,
  DocumentTreeReceipt,
  DocumentTreeTrashItem,
} from "../../../shared/documents/navigation.js";
import { validateDocumentTree } from "../../../shared/documents/navigation.js";
import { DocumentError } from "../errors.js";
import { DocumentOwnershipRepository } from "../ownership/repository.js";
import { assertOwnershipVisible } from "../ownership/record.js";
import { migrateDocumentNavigation } from "./schema.js";

export interface DocumentTreeRow extends DocumentTreePlacement {
  document: DocumentRecord;
  trashed: boolean;
}
export interface DocumentTreeTombstone extends DocumentTreePlacement {
  operationId: string;
}
/** This repository owns navigation metadata only. It never reads or rewrites source/revision bodies. */
export class DocumentNavigationRepository {
  constructor(private db: Database) {
    migrateDocumentNavigation(db);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  version(spaceId: string): number | null {
    return (
      this.db
        .query<{ version: number }, [string]>("SELECT version FROM document_tree_versions WHERE spaceId=?")
        .get(spaceId)?.version ?? null
    );
  }
  initialize(spaceId: string, placements: DocumentTreePlacement[]) {
    return this.transaction(() => {
      if (this.version(spaceId) !== null) return false;
      validateDocumentTree(placements);
      this.db.query("INSERT INTO document_tree_versions VALUES(?,?)").run(spaceId, placements.length ? 1 : 0);
      for (const node of placements) this.insert(spaceId, node);
      return true;
    });
  }
  insert(spaceId: string, node: DocumentTreePlacement) {
    const result = this.db
      .query(
        "INSERT INTO document_tree_nodes(documentId,spaceId,parentId,position) SELECT id,spaceId,?,? FROM documents WHERE id=? AND spaceId=?",
      )
      .run(node.parentId, node.position, node.documentId, spaceId);
    if (result.changes !== 1) throw new DocumentError("notFound", 404);
  }
  rows(spaceId: string): DocumentTreeRow[] {
    const rows = this.db
      .query<DocumentRecord & { parentId: string | null; position: number; trashed: number }, [string]>(
        `SELECT d.*,n.parentId,n.position,EXISTS(SELECT 1 FROM document_trash t WHERE t.documentId=d.id) AS trashed FROM document_tree_nodes n JOIN documents d ON d.id=n.documentId AND d.spaceId=n.spaceId WHERE n.spaceId=? ORDER BY n.position,n.documentId`,
      )
      .all(spaceId);
    return rows.map(({ parentId, position, trashed, ...document }) => ({
      documentId: document.id,
      parentId,
      position,
      document,
      trashed: !!trashed,
    }));
  }
  unregistered(spaceId: string): DocumentRecord[] {
    return this.db
      .query<DocumentRecord, [string]>(
        "SELECT d.* FROM documents d LEFT JOIN document_tree_nodes n ON n.documentId=d.id WHERE d.spaceId=? AND n.documentId IS NULL AND NOT EXISTS(SELECT 1 FROM document_trash t WHERE t.documentId=d.id) ORDER BY d.path,d.id LIMIT 5001",
      )
      .all(spaceId);
  }
  origins(spaceId: string) {
    return new Map(
      this.db
        .query<{ path: string; documentId: string }, [string]>(
          "SELECT path,documentId FROM document_tree_folder_origins WHERE spaceId=?",
        )
        .all(spaceId)
        .map((row) => [row.path, row.documentId]),
    );
  }
  origin(spaceId: string, path: string, documentId: string) {
    this.db.query("INSERT INTO document_tree_folder_origins VALUES(?,?,?)").run(spaceId, path, documentId);
  }
  bump(spaceId: string, expected: number) {
    if (
      this.db
        .query("UPDATE document_tree_versions SET version=version+1 WHERE spaceId=? AND version=?")
        .run(spaceId, expected).changes !== 1
    )
      throw new DocumentError("navigationConflict", 409);
  }
  replace(spaceId: string, placements: DocumentTreePlacement[]) {
    this.transaction(() => {
      validateDocumentTree(placements);
      const current = new Map(
        this.db
          .query<DocumentTreePlacement, [string]>(
            "SELECT documentId,parentId,position FROM document_tree_nodes WHERE spaceId=?",
          )
          .all(spaceId)
          .map((node) => [node.documentId, node]),
      );
      if (current.size !== placements.length || placements.some((node) => !current.has(node.documentId)))
        throw new DocumentError("invalidInput");
      const update = this.db.query(
        "UPDATE document_tree_nodes SET parentId=?,position=? WHERE documentId=? AND spaceId=?",
      );
      for (const node of placements) {
        const previous = current.get(node.documentId)!;
        if (previous.parentId !== node.parentId || previous.position !== node.position)
          update.run(node.parentId, node.position, node.documentId, spaceId);
      }
    });
  }
  operation(spaceId: string, owner: string, id: string, request: string): string | null {
    return this.operationRecord(spaceId, owner, id, request)?.documentId ?? null;
  }
  private operationRecord(spaceId: string, owner: string, id: string, request: string) {
    const row = this.db
      .query<{ spaceId: string; owner: string; request: string; documentId: string; result: string | null }, [string]>(
        "SELECT spaceId,owner,request,documentId,result FROM document_tree_operations WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    if (row.spaceId !== spaceId || row.owner !== owner) throw new DocumentError("notFound", 404);
    if (row.request !== request) throw new DocumentError("conflict", 409);
    return row;
  }
  receipt(spaceId: string, owner: string, id: string, request: string): DocumentTreeReceipt | null {
    const row = this.operationRecord(spaceId, owner, id, request);
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
  recordOperation(
    spaceId: string,
    owner: string,
    id: string,
    request: string,
    documentId: string,
    result?: DocumentTreeReceipt,
  ) {
    this.db
      .query(
        "INSERT INTO document_tree_operations(id,spaceId,owner,request,documentId,createdAt,result) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, spaceId, owner, request, documentId, Date.now(), result ? JSON.stringify(result) : null);
  }
  tombstones(spaceId: string, operationId: string): DocumentTreeTombstone[] {
    return this.db
      .query<DocumentTreeTombstone, [string, string]>(
        "SELECT documentId,parentId,position,operationId FROM document_tree_trash WHERE spaceId=? AND operationId=? LIMIT 5001",
      )
      .all(spaceId, operationId);
  }
  tombstone(spaceId: string, documentId: string): DocumentTreeTombstone | null {
    return this.db
      .query<DocumentTreeTombstone, [string, string]>(
        "SELECT documentId,parentId,position,operationId FROM document_tree_trash WHERE spaceId=? AND documentId=?",
      )
      .get(spaceId, documentId);
  }
  forgetTombstones(ids: string[]) {
    const remove = this.db.query("DELETE FROM document_tree_trash WHERE documentId=?");
    for (const id of ids) remove.run(id);
  }
  retire(spaceId: string, ids: string[], operationId: string) {
    const snapshot = this.db.query(
        "INSERT INTO document_tree_trash(documentId,spaceId,parentId,position,operationId) SELECT documentId,spaceId,parentId,position,? FROM document_tree_nodes WHERE documentId=? AND spaceId=? ON CONFLICT(documentId) DO UPDATE SET parentId=excluded.parentId,position=excluded.position,operationId=excluded.operationId",
      ),
      trash = this.db.query("INSERT INTO document_trash VALUES(?,?) ON CONFLICT(documentId) DO NOTHING"),
      remove = this.db.query("DELETE FROM document_tree_nodes WHERE documentId=? AND spaceId=?");
    for (const id of ids) {
      if (snapshot.run(operationId, id, spaceId).changes !== 1) throw new DocumentError("notFound", 404);
      trash.run(id, Date.now());
      remove.run(id, spaceId);
    }
  }
  revive(ids: string[]) {
    const remove = this.db.query("DELETE FROM document_trash WHERE documentId=?");
    for (const id of ids) {
      assertOwnershipVisible(new DocumentOwnershipRepository(this.db).forDocument(id));
      remove.run(id);
    }
    this.forgetTombstones(ids);
  }
  trashList(spaceId: string): DocumentTreeTrashItem[] {
    return this.trashPage(spaceId, null).documents;
  }
  trashPage(spaceId: string, after: { deletedAt: number; documentId: string } | null) {
    const roots = this.db
      .query<
        DocumentRecord & { deletedAt: number; operationId: string | null },
        [string, number | null, number | null, number | null, string]
      >(
        `SELECT d.*,x.deletedAt,t.operationId FROM documents d JOIN document_trash x ON x.documentId=d.id LEFT JOIN document_tree_trash t ON t.documentId=d.id WHERE d.spaceId=? AND ${sqliteOwnershipVisible("d")} AND (t.documentId IS NULL OR NOT EXISTS(SELECT 1 FROM document_tree_trash p JOIN document_trash z ON z.documentId=p.documentId WHERE p.documentId=t.parentId AND p.operationId=t.operationId AND p.spaceId=t.spaceId)) AND (? IS NULL OR x.deletedAt<? OR (x.deletedAt=? AND d.id>?)) ORDER BY x.deletedAt DESC,d.id LIMIT 201`,
      )
      .all(
        spaceId,
        after?.deletedAt ?? null,
        after?.deletedAt ?? null,
        after?.deletedAt ?? null,
        after?.documentId ?? "",
      );
    const documents = roots.slice(0, 200).map(({ deletedAt, operationId, ...document }) => {
      const count = operationId
        ? this.db
            .query<{ count: number }, [string, string, string]>(
              `WITH RECURSIVE branch(documentId,depth) AS (SELECT ?,1 UNION ALL SELECT t.documentId,b.depth+1 FROM document_tree_trash t JOIN branch b ON t.parentId=b.documentId JOIN document_trash x ON x.documentId=t.documentId WHERE t.spaceId=? AND t.operationId=? AND b.depth<32) SELECT COUNT(*) AS count FROM branch`,
            )
            .get(document.id, spaceId, operationId)!.count
        : 1;
      return { document, deletedAt, subtreeCount: count };
    });
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
