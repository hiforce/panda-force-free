import { migrateGenerationSources } from "./generation-source-schema.js";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { createGenerationSchema } from "./generation-schema.js";
import { migrateGenerationBudgets } from "./generation-budget-schema.js";

/** Only identities, digests, leases and receipts belong to this ledger. Content belongs to immutable files. */
export function openKnowledgeDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 8) throw new KnowledgeTaskError("unavailable");
      if (!version)
        db.exec(`
          CREATE TABLE knowledge_tasks (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL,
            signature TEXT NOT NULL, inputDigest TEXT NOT NULL, dialogueDigest TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','review','committing','completed','failed','cancelled','stale')),
            generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
            rounds INTEGER NOT NULL DEFAULT 0, reviewRevision INTEGER NOT NULL DEFAULT 0,
            draftDigest TEXT, outputDigest TEXT, result TEXT, failure TEXT, outputAttempts INTEGER NOT NULL DEFAULT 0, nextOutputAt INTEGER NOT NULL DEFAULT 0,
            leaseUntil INTEGER, token TEXT, sessionId TEXT, runId TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            CHECK((state='running')=(token IS NOT NULL)),
            CHECK(state!='review' OR draftDigest IS NOT NULL),
            CHECK(state!='committing' OR outputDigest IS NOT NULL),
            CHECK(state!='completed' OR result IS NOT NULL)
          );
          CREATE TABLE knowledge_submissions (
            owner TEXT NOT NULL, operationId TEXT NOT NULL, requestHash TEXT NOT NULL,
            taskId TEXT NOT NULL REFERENCES knowledge_tasks(id), PRIMARY KEY(owner,operationId)
          );
          CREATE INDEX knowledge_queue ON knowledge_tasks(state,leaseUntil,createdAt);
          CREATE INDEX knowledge_owner ON knowledge_tasks(owner,project,createdAt);
          CREATE UNIQUE INDEX knowledge_active_signature ON knowledge_tasks(owner,signature)
            WHERE state IN ('queued','running','waiting','review','committing');
          PRAGMA user_version=1;
        `);
      if (version < 2)
        db.exec(`
        ALTER TABLE knowledge_tasks ADD COLUMN autoEligible INTEGER NOT NULL DEFAULT 1 CHECK(autoEligible IN (0,1));
        CREATE TABLE knowledge_review_policies (
          owner TEXT NOT NULL, project TEXT NOT NULL, automatic INTEGER NOT NULL CHECK(automatic IN (0,1)),
          revision INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(owner,project)
        );
        CREATE TABLE knowledge_reviews (
          id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES knowledge_tasks(id), owner TEXT NOT NULL, project TEXT NOT NULL,
          taskRevision INTEGER NOT NULL, policyRevision INTEGER NOT NULL, inputDigest TEXT NOT NULL,
          dialogueDigest TEXT NOT NULL, draftDigest TEXT NOT NULL, state TEXT NOT NULL
            CHECK(state IN ('running','passed','needsReview','failed','superseded')),
          token TEXT NOT NULL, leaseUntil INTEGER NOT NULL, sessionId TEXT, runId TEXT, reportDigest TEXT,
          createdAt INTEGER NOT NULL, finishedAt INTEGER,
          UNIQUE(taskId,taskRevision,policyRevision)
        );
        CREATE INDEX knowledge_reviews_pending ON knowledge_reviews(state,createdAt);
        CREATE INDEX knowledge_reviews_owner ON knowledge_reviews(owner,state,leaseUntil);
        CREATE INDEX knowledge_execution_owner ON knowledge_tasks(owner,state,leaseUntil);
        PRAGMA user_version=2;
      `);
      if (version < 3)
        db.exec(`
        CREATE TABLE knowledge_catalog (
          taskId TEXT PRIMARY KEY REFERENCES knowledge_tasks(id), outputDigest TEXT NOT NULL,
          projection TEXT NOT NULL, digest TEXT NOT NULL
        );
        CREATE INDEX knowledge_completed_project ON knowledge_tasks(project,state,id);
        PRAGMA user_version=3;
      `);
      if (version < 4) createGenerationSchema(db);
      if (version < 5) migrateGenerationBudgets(db);
      if (version < 6)
        db.exec(`
        CREATE INDEX IF NOT EXISTS knowledge_access_tasks ON knowledge_tasks(owner,project,id) WHERE state IN ('queued','running','waiting','review');
        CREATE INDEX IF NOT EXISTS knowledge_access_generation ON knowledge_generation_policies(owner,project) WHERE enabled=1;
        CREATE INDEX IF NOT EXISTS knowledge_access_review ON knowledge_review_policies(owner,project) WHERE automatic=1;
        PRAGMA user_version=6;
      `);
      if (version < 7)
        db.exec(`CREATE INDEX IF NOT EXISTS knowledge_history_page ON knowledge_tasks(owner,project,createdAt DESC,id DESC);
          PRAGMA user_version=7;`);
      if (version < 8) migrateGenerationSources(db);
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_tasks'").get())
        throw new KnowledgeTaskError("unavailable");
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
