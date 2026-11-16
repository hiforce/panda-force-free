import type { Database } from "bun:sqlite";
import { EditorialError } from "./errors.js";
import { createHash } from "node:crypto";
import type { EditorialProposal } from "../../shared/editorial/contracts.js";
import { EditorialHistoryRepository } from "./history/repository.js";

/** This bounded context shares the document database without owning its user_version or source schema. */
export function migrateEditorial(db: Database) {
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS editorial_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
    );
    const version =
      db.query<{ version: number }, []>("SELECT version FROM editorial_schema WHERE id=1").get()?.version || 0;
    if (version > 4) throw new EditorialError("unavailable", 503);
    if (version < 1) {
      db.exec(`CREATE TABLE editorial_proposals (id TEXT PRIMARY KEY,documentId TEXT NOT NULL,owner TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE INDEX editorial_by_source ON editorial_proposals(owner,documentId,createdAt);
        CREATE TABLE editorial_applications (proposalId TEXT PRIMARY KEY REFERENCES editorial_proposals(id),selection TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
        INSERT INTO editorial_schema(id,version) VALUES(1,1);`);
    }
    if (version < 2) {
      db.exec(`CREATE TABLE editorial_jobs (
        id TEXT PRIMARY KEY,owner TEXT NOT NULL,documentId TEXT NOT NULL,request TEXT NOT NULL,
        payload TEXT NOT NULL,digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,budget INTEGER NOT NULL DEFAULT 3,
        leaseToken TEXT,leaseUntil INTEGER,proposalId TEXT REFERENCES editorial_proposals(id),failure TEXT,
        createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
        CREATE INDEX editorial_jobs_queue ON editorial_jobs(state,createdAt);
        CREATE INDEX editorial_jobs_owner ON editorial_jobs(owner,documentId,createdAt);
        CREATE TABLE editorial_job_retries (jobId TEXT NOT NULL REFERENCES editorial_jobs(id),retryId TEXT NOT NULL,PRIMARY KEY(jobId,retryId));
        UPDATE editorial_schema SET version=2 WHERE id=1;`);
    }
    if (version < 3) {
      db.exec(`CREATE TABLE editorial_history(id TEXT PRIMARY KEY REFERENCES editorial_proposals(id),owner TEXT NOT NULL,documentId TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,createdAt INTEGER NOT NULL,sequence INTEGER NOT NULL);
        CREATE INDEX editorial_history_page ON editorial_history(owner,documentId,createdAt DESC,sequence DESC);`);
      const history = new EditorialHistoryRepository(db);
      for (const row of db
        .query<{ id: string; owner: string; documentId: string; payload: string; digest: string }, []>(
          "SELECT id,owner,documentId,payload,digest FROM editorial_proposals ORDER BY rowid",
        )
        .iterate()) {
        if (createHash("sha256").update(row.payload).digest("hex") !== row.digest)
          throw new EditorialError("unavailable", 503);
        const proposal = JSON.parse(row.payload) as EditorialProposal;
        if (proposal.id !== row.id || proposal.source.documentId !== row.documentId)
          throw new EditorialError("unavailable", 503);
        history.insert(row.owner, proposal);
      }
      db.exec("UPDATE editorial_schema SET version=3 WHERE id=1");
    }
    if (version < 4) {
      db.exec(`ALTER TABLE editorial_proposals ADD COLUMN sourceProjectId TEXT;
        ALTER TABLE editorial_history ADD COLUMN sourceProjectId TEXT;
        ALTER TABLE editorial_jobs ADD COLUMN sourceProjectId TEXT;
        CREATE INDEX editorial_scoped_proposals ON editorial_proposals(owner,sourceProjectId,documentId,createdAt);
        CREATE INDEX editorial_scoped_history ON editorial_history(owner,sourceProjectId,documentId,createdAt DESC,sequence DESC);
        CREATE INDEX editorial_scoped_jobs ON editorial_jobs(owner,sourceProjectId,documentId,createdAt);
        CREATE TABLE editorial_application_intents (
          proposalId TEXT PRIMARY KEY REFERENCES editorial_proposals(id),payload TEXT NOT NULL,digest TEXT NOT NULL
        ); UPDATE editorial_schema SET version=4 WHERE id=1;`);
    }
  }).immediate();
}
