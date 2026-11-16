import type { Database } from "bun:sqlite";

/** Generation state is metadata only; admission shares the task ledger transaction and never stores document bodies. */
export function createGenerationSchema(db: Database) {
  db.exec(`
    CREATE TABLE knowledge_generation_policies (
      owner TEXT NOT NULL, project TEXT NOT NULL, revision INTEGER NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), purpose TEXT NOT NULL, selection TEXT NOT NULL,
      dailyLimit INTEGER NOT NULL, pendingLimit INTEGER NOT NULL, observedCommit TEXT, updatedAt INTEGER NOT NULL,
      nextScanAt INTEGER NOT NULL DEFAULT 0, scanFailures INTEGER NOT NULL DEFAULT 0,
      nextAdmissionAt INTEGER,
      PRIMARY KEY(owner,project)
    );
    CREATE TABLE knowledge_generation_jobs (
      owner TEXT NOT NULL, project TEXT NOT NULL, documentId TEXT NOT NULL,
      version TEXT NOT NULL, policyRevision INTEGER NOT NULL, operationId TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('observed','queued','claimed','admitted','failed','excluded')),
      token TEXT, leaseUntil INTEGER, notBefore INTEGER NOT NULL, failures INTEGER NOT NULL,
      taskId TEXT REFERENCES knowledge_tasks(id), updatedAt INTEGER NOT NULL,
      PRIMARY KEY(owner,project,documentId),
      FOREIGN KEY(owner,project) REFERENCES knowledge_generation_policies(owner,project),
      CHECK((state='claimed')=(token IS NOT NULL))
    );
    CREATE INDEX knowledge_generation_policy_scan ON knowledge_generation_policies(enabled,nextScanAt,owner,project);
    CREATE INDEX knowledge_generation_dispatch ON knowledge_generation_policies(enabled,scanFailures,nextAdmissionAt,owner,project);
    CREATE INDEX knowledge_generation_ready ON knowledge_generation_jobs(owner,project,state,notBefore,updatedAt,documentId);
    CREATE INDEX knowledge_generation_expired ON knowledge_generation_jobs(owner,project,state,leaseUntil,updatedAt,documentId);
    CREATE TABLE knowledge_generation_origins (
      taskId TEXT PRIMARY KEY REFERENCES knowledge_tasks(id), owner TEXT NOT NULL, project TEXT NOT NULL,
      documentId TEXT NOT NULL, version TEXT NOT NULL, policyRevision INTEGER NOT NULL, createdAt INTEGER NOT NULL,
      manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1))
    );
    CREATE INDEX knowledge_generation_origin_scope ON knowledge_generation_origins(owner,project,documentId,taskId);
    CREATE TABLE knowledge_generation_usage (
      owner TEXT NOT NULL, project TEXT NOT NULL, day INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY(owner,project,day)
    );
    PRAGMA user_version=4;
  `);
}
