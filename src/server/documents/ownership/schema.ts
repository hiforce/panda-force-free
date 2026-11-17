import type { Database } from "bun:sqlite";
import { DocumentError } from "../errors.js";

/** Additive ownership metadata has its own version; historical document content schema versions stay unchanged. */
export function migrateDocumentOwnership(db: Database) {
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS document_ownership_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    const version =
      db.query<{ version: number }, []>("SELECT version FROM document_ownership_schema WHERE id=1").get()?.version ?? 0;
    if (version > 1) throw new DocumentError("unsupportedSchema", 503);
    if (!version)
      db.exec(
        `CREATE TABLE document_ownership_records(spaceId TEXT NOT NULL REFERENCES document_spaces(id),documentId TEXT NOT NULL REFERENCES documents(id),record TEXT NOT NULL,PRIMARY KEY(spaceId,documentId));INSERT INTO document_ownership_schema VALUES(1,1);`,
      );
  }).immediate();
}
