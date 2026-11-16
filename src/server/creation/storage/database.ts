import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { CreationError } from "../contracts.js";

/** This ledger owns execution metadata only. Immutable prompts and generated document source belong to file adapters. */
export function openCreationDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 2) throw new CreationError("unavailable");
      if (!version)
        db.exec(`
          CREATE TABLE creation_tasks (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, projectId TEXT NOT NULL,
            operationId TEXT NOT NULL UNIQUE, spec TEXT NOT NULL, signature TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','running','committing','succeeded','failed','cancelled')),
            generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
            token TEXT, leaseUntil INTEGER, sessionId TEXT, runId TEXT,
            cancelRequested INTEGER NOT NULL DEFAULT 0 CHECK(cancelRequested IN (0,1)),
            outputDigest TEXT, artifact TEXT, failure TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            CHECK(state!='committing' OR outputDigest IS NOT NULL),
            CHECK(state!='succeeded' OR artifact IS NOT NULL),
            CHECK(artifact IS NULL OR outputDigest IS NOT NULL)
          );
          CREATE INDEX creation_active ON creation_tasks(state,leaseUntil);
          CREATE INDEX creation_owner ON creation_tasks(owner,projectId,createdAt);
          PRAGMA user_version=1;
        `);
      if (version < 2)
        db.exec(`
        ALTER TABLE creation_tasks ADD COLUMN budget INTEGER NOT NULL DEFAULT 3;
        UPDATE creation_tasks SET budget=MAX(0,3-attempts);
        CREATE TABLE creation_questions (
          id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES creation_tasks(id), owner TEXT NOT NULL,
          generation INTEGER NOT NULL, questionDigest TEXT NOT NULL, answerDigest TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending','answered','expired')),
          createdAt INTEGER NOT NULL, answeredAt INTEGER,
          UNIQUE(taskId,generation,questionDigest), CHECK((state='answered')=(answerDigest IS NOT NULL))
        );
        CREATE UNIQUE INDEX creation_one_pending_question ON creation_questions(taskId) WHERE state='pending';
        CREATE TABLE creation_actions (id TEXT PRIMARY KEY,owner TEXT NOT NULL,taskId TEXT NOT NULL REFERENCES creation_tasks(id),request TEXT NOT NULL,createdAt INTEGER NOT NULL);
        PRAGMA user_version=2;
      `);
      if (!db.query("SELECT 1 FROM sqlite_master WHERE name='creation_tasks' AND type='table'").get())
        throw new CreationError("unavailable");
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
