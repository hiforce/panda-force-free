import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DocumentError } from "./errors.js";

/** One owner opens and migrates the feature database; repositories share transactions. */
export function openDocumentDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (version > 6) {
    db.close();
    throw new DocumentError("unsupportedSchema", 503);
  }
  if (!version)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE document_spaces (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, code TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL, engine TEXT NOT NULL, theme TEXT NOT NULL,
        sourceMode TEXT NOT NULL, sourceRoot TEXT NOT NULL, locale TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(projectId, code)
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES document_spaces(id),
        path TEXT NOT NULL, title TEXT NOT NULL, locale TEXT NOT NULL,
        revision INTEGER NOT NULL, revisionId TEXT NOT NULL,
        contentHash TEXT NOT NULL, importedHash TEXT, importedRevision INTEGER, updatedAt INTEGER NOT NULL,
        UNIQUE(spaceId, path)
      );
      CREATE TABLE document_revisions (
        id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id),
        number INTEGER NOT NULL, title TEXT NOT NULL, locale TEXT NOT NULL,
        content TEXT NOT NULL, contentHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        UNIQUE(documentId, number)
      );
      CREATE INDEX documents_by_space ON documents(spaceId, path);
      CREATE INDEX revisions_by_document ON document_revisions(documentId, number);
      PRAGMA user_version=1;
    `);
    }).immediate();
  if (version < 2)
    db.transaction(() => {
      db.exec(`CREATE TABLE document_assets (
      id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id), name TEXT NOT NULL,
      mime TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL,
      height INTEGER NOT NULL, alt TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX assets_by_document ON document_assets(documentId,createdAt);
    CREATE TABLE document_languages (documentId TEXT PRIMARY KEY REFERENCES documents(id), groupId TEXT NOT NULL);
    CREATE INDEX languages_by_group ON document_languages(groupId);
    PRAGMA user_version=2;`);
    }).immediate();
  if (version < 3)
    db.transaction(() => {
      db.exec(`CREATE TABLE document_revision_assets (
      revisionId TEXT NOT NULL REFERENCES document_revisions(id), source TEXT NOT NULL,
      assetId TEXT NOT NULL REFERENCES document_assets(id), sourcePath TEXT NOT NULL,
      PRIMARY KEY(revisionId,source)
    ); PRAGMA user_version=3;`);
    }).immediate();
  if (version < 4)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE document_site_profiles (spaceId TEXT PRIMARY KEY REFERENCES document_spaces(id), profile TEXT NOT NULL); PRAGMA user_version=4;",
      );
    }).immediate();
  if (version < 5)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE project_document_libraries (
        projectId TEXT PRIMARY KEY,spaceId TEXT NOT NULL UNIQUE REFERENCES document_spaces(id)
      );
      CREATE TABLE document_folders (
        id TEXT PRIMARY KEY,spaceId TEXT NOT NULL REFERENCES document_spaces(id),path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,UNIQUE(spaceId,path)
      );
      CREATE TABLE document_trash (
        documentId TEXT PRIMARY KEY REFERENCES documents(id),deletedAt INTEGER NOT NULL
      );
      CREATE TABLE document_rich_revisions (
        revisionId TEXT PRIMARY KEY REFERENCES document_revisions(id),body TEXT NOT NULL
      );
      PRAGMA user_version=5;`);
    }).immediate();
  if (version < 6)
    db.transaction(() => {
      db.exec(`CREATE TABLE document_placements (
      id TEXT PRIMARY KEY,projectId TEXT NOT NULL,documentId TEXT NOT NULL REFERENCES documents(id),
      spaceId TEXT NOT NULL REFERENCES document_spaces(id),path TEXT NOT NULL,pathKey TEXT NOT NULL,
      locale TEXT NOT NULL,revisionId TEXT REFERENCES document_revisions(id),metadata TEXT NOT NULL,
      version INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,deletedAt INTEGER
    );
    CREATE UNIQUE INDEX placement_target_path ON document_placements(spaceId,pathKey) WHERE deletedAt IS NULL;
    CREATE UNIQUE INDEX placement_source_edition ON document_placements(documentId,spaceId,lower(locale)) WHERE deletedAt IS NULL;
    CREATE INDEX placements_by_document ON document_placements(documentId);
    CREATE TABLE document_placement_events (
      placementId TEXT NOT NULL REFERENCES document_placements(id),version INTEGER NOT NULL,
      operation TEXT NOT NULL,snapshot TEXT NOT NULL,actor TEXT NOT NULL,createdAt INTEGER NOT NULL,
      PRIMARY KEY(placementId,version)
    );PRAGMA user_version=6;`);
    }).immediate();
  return db;
}
