import type { Database } from "bun:sqlite";
import { DocumentError } from "../errors.js";

/** Navigation owns its additive schema without changing content, revisions or the document user_version. */
export function migrateDocumentNavigation(db: Database) {
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS document_navigation_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    const version =
      db.query<{ version: number }, []>("SELECT version FROM document_navigation_schema WHERE id=1").get()?.version ||
      0;
    if (version > 2) throw new DocumentError("unsupportedSchema", 503);
    if (version === 0) {
      db.exec(`CREATE TABLE document_tree_versions(spaceId TEXT PRIMARY KEY REFERENCES document_spaces(id),version INTEGER NOT NULL CHECK(version>=0));
        CREATE TABLE document_tree_nodes(documentId TEXT PRIMARY KEY REFERENCES documents(id),spaceId TEXT NOT NULL REFERENCES document_spaces(id),parentId TEXT,position INTEGER NOT NULL CHECK(position>=0),UNIQUE(documentId,spaceId),FOREIGN KEY(parentId,spaceId) REFERENCES document_tree_nodes(documentId,spaceId) DEFERRABLE INITIALLY DEFERRED);
        CREATE INDEX document_tree_children ON document_tree_nodes(spaceId,parentId,position,documentId);
        CREATE TABLE document_tree_operations(id TEXT PRIMARY KEY,spaceId TEXT NOT NULL REFERENCES document_spaces(id),owner TEXT NOT NULL,request TEXT NOT NULL,documentId TEXT NOT NULL REFERENCES documents(id),createdAt INTEGER NOT NULL);
        CREATE TABLE document_tree_trash(documentId TEXT PRIMARY KEY REFERENCES document_tree_nodes(documentId),operationId TEXT NOT NULL REFERENCES document_tree_operations(id) DEFERRABLE INITIALLY DEFERRED);
        INSERT INTO document_navigation_schema VALUES(1,1);`);
    }
    if (version < 2) {
      db.exec(`ALTER TABLE document_tree_operations ADD COLUMN result TEXT;
        ALTER TABLE document_tree_trash RENAME TO document_tree_trash_legacy;
        CREATE TABLE document_tree_trash(documentId TEXT PRIMARY KEY REFERENCES documents(id),spaceId TEXT NOT NULL REFERENCES document_spaces(id),parentId TEXT REFERENCES documents(id),position INTEGER NOT NULL CHECK(position>=0),operationId TEXT NOT NULL REFERENCES document_tree_operations(id) DEFERRABLE INITIALLY DEFERRED);
        INSERT INTO document_tree_trash SELECT n.documentId,n.spaceId,n.parentId,n.position,t.operationId FROM document_tree_trash_legacy t JOIN document_tree_nodes n ON n.documentId=t.documentId;
        DROP TABLE document_tree_trash_legacy;
        CREATE INDEX document_tree_trash_children ON document_tree_trash(spaceId,operationId,parentId);
        CREATE TABLE document_tree_folder_origins(spaceId TEXT NOT NULL REFERENCES document_spaces(id),path TEXT NOT NULL,documentId TEXT NOT NULL REFERENCES documents(id),PRIMARY KEY(spaceId,path));
        UPDATE document_navigation_schema SET version=2 WHERE id=1;`);
    }
  }).immediate();
}
