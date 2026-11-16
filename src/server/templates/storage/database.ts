import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { PortableRegistryError } from "../portable/errors.js";

/** Template bodies live in immutable files; this database contains registry metadata and receipts only. */
export function openPortableTemplateDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 4) throw new PortableRegistryError("unavailable");
      if (!version)
        db.exec(`
        CREATE TABLE portable_template_registry (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT INTO portable_template_registry VALUES(1,0);
        CREATE TABLE portable_template_versions (
          id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,origin TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),installedAt INTEGER NOT NULL,installedBy TEXT NOT NULL,
          PRIMARY KEY(id,version)
        );
        CREATE TABLE portable_template_heads (id TEXT PRIMARY KEY,version TEXT NOT NULL,FOREIGN KEY(id,version) REFERENCES portable_template_versions(id,version));
        CREATE TABLE portable_template_operations (actor TEXT NOT NULL,operationId TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(actor,operationId));
        CREATE TABLE portable_template_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,action TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,actor TEXT NOT NULL,createdAt INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
      if (version < 2)
        db.exec(`
        CREATE TABLE portable_template_drafts (
          id TEXT PRIMARY KEY,owner TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),digest TEXT NOT NULL,
          manifest TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,removed INTEGER NOT NULL CHECK(removed IN(0,1))
        );
        CREATE INDEX portable_template_drafts_owner ON portable_template_drafts(owner,removed,updatedAt);
        CREATE TABLE portable_template_draft_revisions (id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,revision),FOREIGN KEY(id) REFERENCES portable_template_drafts(id));
        CREATE TABLE portable_template_draft_operations (owner TEXT NOT NULL,operationId TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(owner,operationId));
        PRAGMA user_version=2;
      `);
      if (version < 3)
        db.exec(`
        CREATE TABLE portable_template_draft_images (
          draft TEXT NOT NULL,id TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),metadata TEXT NOT NULL,
          PRIMARY KEY(draft,id),FOREIGN KEY(draft) REFERENCES portable_template_drafts(id)
        );
        PRAGMA user_version=3;
      `);
      // Version four admits immutable captured-source provenance without rewriting legacy metadata or receipts.
      if (version < 4) db.exec("PRAGMA user_version=4;");
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
