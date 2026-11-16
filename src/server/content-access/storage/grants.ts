import type { Database } from "bun:sqlite";
import { ContentAccessError, contentAccessOwner, contentAccessProject, type ContentAccessRole } from "../contracts.js";

export interface ContentAccessGrant {
  owner: string;
  role: ContentAccessRole;
  updatedAt: number;
}
/** Membership metadata shares the existing project catalog database, never a document or search body store. */
export class ContentAccessStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS content_access_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO content_access_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS content_access_grants(
        project TEXT NOT NULL REFERENCES projects(id),owner TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('reader','contributor','blocked')),
        updatedAt INTEGER NOT NULL,PRIMARY KEY(project,owner));
      CREATE INDEX IF NOT EXISTS content_access_by_owner ON content_access_grants(owner,project);
      CREATE TABLE IF NOT EXISTS content_access_changes(
        revision INTEGER PRIMARY KEY,project TEXT NOT NULL,owner TEXT NOT NULL,role TEXT,actor TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  }
  revision() {
    const revision = this.db
      .query<{ revision: number }, []>("SELECT revision FROM content_access_meta WHERE id=1")
      .get()?.revision;
    if (!Number.isSafeInteger(revision) || revision! < 0) throw new ContentAccessError("unavailable");
    return revision!;
  }
  role(owner: string, project: string) {
    const role =
      this.db
        .query<{ role: ContentAccessRole }, [string, string]>(
          "SELECT role FROM content_access_grants WHERE owner=? AND project=?",
        )
        .get(owner, project)?.role ?? null;
    if (role !== null && !["reader", "contributor", "blocked"].includes(role))
      throw new ContentAccessError("unavailable");
    return role;
  }
  grants(project: string) {
    const snapshot = this.db.transaction(() => ({
      revision: this.revision(),
      grants: this.db
        .query<ContentAccessGrant, [string]>(
          "SELECT owner,role,updatedAt FROM content_access_grants WHERE project=? ORDER BY owner",
        )
        .all(project),
    }))();
    for (const row of snapshot.grants) {
      if (
        !/^[a-f0-9]{64}$/.test(row.owner) ||
        !["reader", "contributor", "blocked"].includes(row.role) ||
        !Number.isSafeInteger(row.updatedAt)
      )
        throw new ContentAccessError("unavailable");
    }
    return snapshot;
  }
  /** The application also holds the project's file lease while replacing membership. */
  set(actor: string, project: string, owner: string, role: ContentAccessRole | null, revision: number, now: number) {
    contentAccessOwner(actor);
    contentAccessOwner(owner);
    contentAccessProject(project);
    if (
      project === "personal" ||
      ![null, "reader", "contributor", "blocked"].includes(role) ||
      !Number.isSafeInteger(revision)
    )
      throw new ContentAccessError("invalidInput");
    return this.db
      .transaction(() => {
        if (this.revision() !== revision) throw new ContentAccessError("conflict");
        const previous = this.role(owner, project);
        if (previous === role) return this.grants(project);
        if (role) {
          const count = this.db
            .query<{ total: number; projectTotal: number }, [string]>(
              "SELECT COUNT(*) total,SUM(CASE WHEN project=? THEN 1 ELSE 0 END) projectTotal FROM content_access_grants",
            )
            .get(project)!;
          if (previous === null && (count.total >= 10000 || count.projectTotal >= 1000))
            throw new ContentAccessError("unavailable");
          this.db
            .query(
              "INSERT INTO content_access_grants VALUES(?,?,?,?) ON CONFLICT(project,owner) DO UPDATE SET role=excluded.role,updatedAt=excluded.updatedAt",
            )
            .run(project, owner, role, now);
        } else this.db.query("DELETE FROM content_access_grants WHERE project=? AND owner=?").run(project, owner);
        this.db.query("UPDATE content_access_meta SET revision=revision+1 WHERE id=1").run();
        this.db
          .query("INSERT INTO content_access_changes VALUES(?,?,?,?,?,?)")
          .run(revision + 1, project, owner, role, actor, now);
        return this.grants(project);
      })
      .immediate();
  }
}
