import type { Database } from "bun:sqlite";

/** This is project routing metadata only; document text, revisions, images and search indexes never enter this table. */
export class ProjectDocumentStorage {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_document_storage (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      storage TEXT NOT NULL CHECK(storage='files'), created_at INTEGER NOT NULL
    )`);
  }
  files(projectId: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM project_document_storage WHERE project_id=? AND storage='files'")
      .get(projectId);
  }
  /** Bind inside the project creation transaction; there is no implicit downgrade or database-body fallback. */
  bindFiles(projectId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO project_document_storage(project_id,storage,created_at) VALUES(?,'files',?)")
      .run(projectId, Date.now());
  }
}
