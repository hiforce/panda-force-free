import type { Database } from "bun:sqlite";
import type { DocumentPlacement, DocumentPlacementEvent } from "../../../shared/documents/placements.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../errors.js";

type Row = Omit<DocumentPlacement, "metadata"> & { metadata: string; pathKey: string };
const pathKey = (value: string) => value.normalize("NFC").toLowerCase();
function decode(row: Row): DocumentPlacement {
  const { metadata, ...record } = row;
  const { pathKey, ...publicRecord } = record;
  void pathKey;
  return { ...publicRecord, metadata: JSON.parse(metadata) };
}
/** Placement updates and their append-only audit records share the document transaction. */
export class DocumentPlacementRepository {
  constructor(private db: Database) {}
  atomic<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
  get(id: string): DocumentPlacement {
    const row = this.db.query<Row, [string]>("SELECT * FROM document_placements WHERE id=?").get(id);
    if (!row) throw new DocumentError("notFound", 404);
    return decode(row);
  }
  find(id: string): DocumentPlacement | null {
    try {
      return this.get(id);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) return null;
      throw error;
    }
  }
  list(kind: "documentId" | "spaceId", id: string): DocumentPlacement[] {
    return this.db
      .query<Row, [string]>(
        `SELECT * FROM document_placements WHERE ${kind}=? AND deletedAt IS NULL ORDER BY createdAt,id`,
      )
      .all(id)
      .map(decode);
  }
  isLibrary(id: string) {
    return !!this.db.query("SELECT 1 FROM project_document_libraries WHERE spaceId=?").get(id);
  }
  private available(value: DocumentPlacement) {
    const conflict = this.db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM document_placements WHERE spaceId=? AND pathKey=? AND deletedAt IS NULL AND id<>?",
      )
      .get(value.spaceId, pathKey(value.path), value.id);
    const occupied = this.db
      .query<{ path: string }, [string]>(
        "SELECT path FROM documents WHERE spaceId=? AND id NOT IN (SELECT documentId FROM document_trash)",
      )
      .all(value.spaceId)
      .some((row) => pathKey(row.path) === pathKey(value.path));
    if (conflict || occupied) throw new DocumentError("placementPathConflict", 409);
    const duplicate = this.db
      .query(
        "SELECT id FROM document_placements WHERE documentId=? AND spaceId=? AND lower(locale)=lower(?) AND deletedAt IS NULL AND id<>?",
      )
      .get(value.documentId, value.spaceId, value.locale, value.id);
    if (duplicate) throw new DocumentError("placementAlreadyLinked", 409);
  }
  private event(value: DocumentPlacement, operation: DocumentPlacementEvent["operation"], actor: string) {
    this.db
      .query("INSERT INTO document_placement_events VALUES (?,?,?,?,?,?)")
      .run(value.id, value.version, operation, stableJson(value), actor, Date.now());
    this.db.query("UPDATE document_spaces SET version=version+1,updatedAt=? WHERE id=?").run(Date.now(), value.spaceId);
  }
  insert(value: DocumentPlacement, actor: string) {
    return this.atomic(() => {
      if (
        this.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM document_placements WHERE spaceId=? AND deletedAt IS NULL",
          )
          .get(value.spaceId)!.count >= 500
      )
        throw new DocumentError("tooManyPlacements", 409);
      this.available(value);
      this.db
        .query("INSERT INTO document_placements VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          value.id,
          value.projectId,
          value.documentId,
          value.spaceId,
          value.path,
          pathKey(value.path),
          value.locale,
          value.revisionId,
          stableJson(value.metadata),
          value.version,
          value.createdAt,
          value.updatedAt,
          value.deletedAt,
        );
      this.event(value, "create", actor);
      return this.get(value.id);
    });
  }
  update(value: DocumentPlacement, expected: number, actor: string) {
    return this.atomic(() => {
      const old = this.get(value.id);
      if (old.deletedAt !== null || old.version !== expected) throw new DocumentError("conflict", 409);
      this.available(value);
      this.db
        .query(
          "UPDATE document_placements SET path=?,pathKey=?,locale=?,revisionId=?,metadata=?,version=version+1,updatedAt=? WHERE id=?",
        )
        .run(
          value.path,
          pathKey(value.path),
          value.locale,
          value.revisionId,
          stableJson(value.metadata),
          Date.now(),
          value.id,
        );
      const updated = this.get(value.id);
      this.event(updated, "update", actor);
      return updated;
    });
  }
  remove(id: string, expected: number, actor: string) {
    return this.atomic(() => {
      const old = this.get(id);
      if (old.deletedAt !== null && (old.version === expected || old.version === expected + 1)) return old;
      if (old.version !== expected) throw new DocumentError("conflict", 409);
      this.db
        .query("UPDATE document_placements SET deletedAt=?,updatedAt=?,version=version+1 WHERE id=?")
        .run(Date.now(), Date.now(), id);
      const updated = this.get(id);
      this.event(updated, "remove", actor);
      return updated;
    });
  }
  history(id: string): DocumentPlacementEvent[] {
    return this.db
      .query<
        { snapshot: string; operation: DocumentPlacementEvent["operation"]; actor: string; createdAt: number },
        [string]
      >(
        "SELECT snapshot,operation,actor,createdAt FROM document_placement_events WHERE placementId=? ORDER BY version DESC LIMIT 100",
      )
      .all(id)
      .map((row) => ({
        placement: JSON.parse(row.snapshot),
        operation: row.operation,
        actor: row.actor,
        createdAt: row.createdAt,
      }));
  }
}
