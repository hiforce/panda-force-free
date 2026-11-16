import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { migrateProjectSearchScopes } from "./scope-migration.js";
import { migrateIndexResources } from "./resource-schema.js";
import { migrateResourceScans } from "./resource-scan-schema.js";
/** Only source registrations, recipes, rules, leases and index references are stored here. No document bodies or FTS. */
export function openSearchDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 6) throw Error("Unsupported search ledger version");
      if (!version)
        db.exec(`
        CREATE TABLE search_sources(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,revision INTEGER NOT NULL);
        INSERT INTO search_sources VALUES('builtin','{"id":"builtin","name":"Built-in search","kind":"local","connection":null,"knowledge":null,"enabled":true,"revision":1}',1);
        CREATE TABLE search_binding(id INTEGER PRIMARY KEY CHECK(id=1),source TEXT,revision INTEGER NOT NULL,FOREIGN KEY(source) REFERENCES search_sources(id));
        INSERT INTO search_binding VALUES(1,'builtin',1);
        CREATE TABLE search_analyzers(reference TEXT PRIMARY KEY,digest TEXT NOT NULL,descriptor TEXT NOT NULL);
        CREATE TABLE search_analyzer_reviews(owner TEXT NOT NULL,digest TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(owner,digest));
        CREATE TABLE search_scopes(
          key TEXT PRIMARY KEY,source TEXT NOT NULL,owner TEXT NOT NULL,project TEXT NOT NULL,
          settings TEXT NOT NULL,revision INTEGER NOT NULL,requested INTEGER NOT NULL,
          state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,token TEXT,leaseUntil INTEGER,
          active TEXT,commitId TEXT,documentCount INTEGER NOT NULL DEFAULT 0,failure TEXT,updatedAt INTEGER NOT NULL,
          UNIQUE(source,owner,project),FOREIGN KEY(source) REFERENCES search_sources(id));
        CREATE INDEX search_pending ON search_scopes(state,updatedAt);
        CREATE TABLE search_retired(id INTEGER PRIMARY KEY,descriptor TEXT NOT NULL,due INTEGER NOT NULL);
        CREATE TABLE search_connections(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,envelope TEXT NOT NULL,binding TEXT NOT NULL);
        CREATE TABLE search_knowledge(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL);
        CREATE TABLE search_meta(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO search_meta VALUES('instance',lower(hex(randomblob(16))));
        PRAGMA user_version=1;
      `);
      if (version < 2)
        db.exec(`
        CREATE TABLE search_audit_queue(key TEXT PRIMARY KEY REFERENCES search_scopes(key) ON DELETE CASCADE,
          generation TEXT NOT NULL,token TEXT,leaseUntil INTEGER NOT NULL,nextAt INTEGER NOT NULL,attempts INTEGER NOT NULL);
        CREATE TABLE search_audit_reports(id INTEGER PRIMARY KEY,key TEXT NOT NULL REFERENCES search_scopes(key) ON DELETE CASCADE,
          generation TEXT NOT NULL,checkedAt INTEGER NOT NULL,report TEXT NOT NULL);
        CREATE INDEX search_audit_reports_scope ON search_audit_reports(key,id);
        PRAGMA user_version=2;
      `);
      if (version < 3) migrateProjectSearchScopes(db);
      if (version < 4)
        db.exec(`CREATE TABLE IF NOT EXISTS search_progress(
        key TEXT PRIMARY KEY REFERENCES search_scopes(key) ON DELETE CASCADE,
        requested INTEGER NOT NULL,token TEXT NOT NULL,phase TEXT NOT NULL,completed INTEGER NOT NULL,total INTEGER,
        startedAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,finishedAt INTEGER);
        PRAGMA user_version=4;`);
      if (version < 5) migrateIndexResources(db);
      if (version < 6) migrateResourceScans(db);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
