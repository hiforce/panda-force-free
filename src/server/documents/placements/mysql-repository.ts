import { documentKeyHash } from "../mysql-session.js";
import type { MySQLDocumentSession } from "../mysql-session.js";
import type { DocumentPlacement, DocumentPlacementEvent } from "../../../shared/documents/placements.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../errors.js";
type Row = Omit<DocumentPlacement, "metadata"> & {
  metadata: string;
  pathKey: string;
};
const pathKey = (value: string) => value.normalize("NFC").toLowerCase();
function decode(row: Row): DocumentPlacement {
  const { metadata, ...record } = row;
  const { pathKey, ...publicRecord } = record;
  void pathKey;
  return { ...publicRecord, metadata: JSON.parse(metadata) };
}
/** Placement updates and their append-only audit records share the document transaction. */
export class MySQLDocumentPlacementRepository {
  constructor(private db: MySQLDocumentSession) {}
  atomic<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
  async get(id: string): Promise<DocumentPlacement> {
    const row = await this.db.one<Row>("SELECT * FROM panda_force_document_placements WHERE id=?", [id]);
    if (!row) throw new DocumentError("notFound", 404);
    return decode(row);
  }
  async find(id: string): Promise<DocumentPlacement | null> {
    try {
      return await this.get(id);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) return null;
      throw error;
    }
  }
  async list(kind: "documentId" | "spaceId", id: string): Promise<DocumentPlacement[]> {
    return (
      await this.db.all<Row>(
        `SELECT * FROM panda_force_document_placements WHERE ${kind}=? AND deletedAt IS NULL ORDER BY createdAt,id`,
        [id],
      )
    ).map(decode);
  }
  async isLibrary(id: string) {
    return !!(await this.db.one("SELECT 1 FROM panda_force_project_document_libraries WHERE spaceId=?", [id]));
  }
  private async available(value: DocumentPlacement) {
    const conflict = await this.db.one<{
      id: string;
    }>("SELECT id FROM panda_force_document_placements WHERE spaceId=? AND pathKey=? AND deletedAt IS NULL AND id<>?", [
      value.spaceId,
      pathKey(value.path),
      value.id,
    ]);
    const occupied = (
      await this.db.all<{
        path: string;
      }>(
        "SELECT path FROM panda_force_documents WHERE spaceId=? AND id NOT IN (SELECT documentId FROM panda_force_document_trash)",
        [value.spaceId],
      )
    ).some((row) => pathKey(row.path) === pathKey(value.path));
    if (conflict || occupied) throw new DocumentError("placementPathConflict", 409);
    const duplicate = await this.db.one(
      "SELECT id FROM panda_force_document_placements WHERE documentId=? AND spaceId=? AND lower(locale)=lower(?) AND deletedAt IS NULL AND id<>?",
      [value.documentId, value.spaceId, value.locale, value.id],
    );
    if (duplicate) throw new DocumentError("placementAlreadyLinked", 409);
  }
  private async event(value: DocumentPlacement, operation: DocumentPlacementEvent["operation"], actor: string) {
    await this.db.run("INSERT INTO panda_force_document_placement_events VALUES (?,?,?,?,?,?)", [
      value.id,
      value.version,
      operation,
      stableJson(value),
      actor,
      Date.now(),
    ]);
    await this.db.run("UPDATE panda_force_document_spaces SET version=version+1,updatedAt=? WHERE id=?", [
      Date.now(),
      value.spaceId,
    ]);
  }
  async insert(value: DocumentPlacement, actor: string) {
    return await this.atomic(async () => {
      if (
        (await this.db.one<{
          count: number;
        }>("SELECT count(*) AS count FROM panda_force_document_placements WHERE spaceId=? AND deletedAt IS NULL", [
          value.spaceId,
        ]))!.count >= 500
      )
        throw new DocumentError("tooManyPlacements", 409);
      await this.available(value);
      await this.db.run(
        "INSERT INTO panda_force_document_placements(id,projectId,documentId,spaceId,path,pathKey,locale,revisionId,metadata,version,createdAt,updatedAt,deletedAt,activePathHash,activeLocale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
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
          value.deletedAt === null ? documentKeyHash(pathKey(value.path)) : null,
          value.deletedAt === null ? value.locale.toLowerCase() : null,
        ],
      );
      await this.event(value, "create", actor);
      return await this.get(value.id);
    });
  }
  async update(value: DocumentPlacement, expected: number, actor: string) {
    return await this.atomic(async () => {
      const old = await this.get(value.id);
      if (old.deletedAt !== null || old.version !== expected) throw new DocumentError("conflict", 409);
      await this.available(value);
      await this.db.run(
        "UPDATE panda_force_document_placements SET path=?,pathKey=?,activePathHash=?,activeLocale=?,locale=?,revisionId=?,metadata=?,version=version+1,updatedAt=? WHERE id=?",
        [
          value.path,
          pathKey(value.path),
          documentKeyHash(pathKey(value.path)),
          value.locale.toLowerCase(),
          value.locale,
          value.revisionId,
          stableJson(value.metadata),
          Date.now(),
          value.id,
        ],
      );
      const updated = await this.get(value.id);
      await this.event(updated, "update", actor);
      return updated;
    });
  }
  async remove(id: string, expected: number, actor: string) {
    return await this.atomic(async () => {
      const old = await this.get(id);
      if (old.deletedAt !== null && (old.version === expected || old.version === expected + 1)) return old;
      if (old.version !== expected) throw new DocumentError("conflict", 409);
      await this.db.run(
        "UPDATE panda_force_document_placements SET deletedAt=?,updatedAt=?,version=version+1,activePathHash=NULL,activeLocale=NULL WHERE id=?",
        [Date.now(), Date.now(), id],
      );
      const updated = await this.get(id);
      await this.event(updated, "remove", actor);
      return updated;
    });
  }
  async history(id: string): Promise<DocumentPlacementEvent[]> {
    return (
      await this.db.all<{
        snapshot: string;
        operation: DocumentPlacementEvent["operation"];
        actor: string;
        createdAt: number;
      }>(
        "SELECT snapshot,operation,actor,createdAt FROM panda_force_document_placement_events WHERE placementId=? ORDER BY version DESC LIMIT 100",
        [id],
      )
    ).map((row) => ({
      placement: JSON.parse(row.snapshot),
      operation: row.operation,
      actor: row.actor,
      createdAt: row.createdAt,
    }));
  }
}
