import { Database } from "bun:sqlite";

/** Fixed schema-two fixture, kept independent of the current migrator. It contains metadata, never document bodies. */
export function openLegacySearchDatabase(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;");
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

        CREATE TABLE search_audit_queue(key TEXT PRIMARY KEY REFERENCES search_scopes(key) ON DELETE CASCADE,
          generation TEXT NOT NULL,token TEXT,leaseUntil INTEGER NOT NULL,nextAt INTEGER NOT NULL,attempts INTEGER NOT NULL);
        CREATE TABLE search_audit_reports(id INTEGER PRIMARY KEY,key TEXT NOT NULL REFERENCES search_scopes(key) ON DELETE CASCADE,
          generation TEXT NOT NULL,checkedAt INTEGER NOT NULL,report TEXT NOT NULL);
        CREATE INDEX search_audit_reports_scope ON search_audit_reports(key,id);
        PRAGMA user_version=2;
      `);
  return db;
}
