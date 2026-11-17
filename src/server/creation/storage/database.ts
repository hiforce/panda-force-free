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
      if (version > 6) throw new CreationError("unavailable");
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
      if (version < 3)
        db.exec(`
        CREATE TABLE creation_progress (
          id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES creation_tasks(id), generation INTEGER NOT NULL,
          createdAt INTEGER NOT NULL, ordinal INTEGER NOT NULL, event TEXT NOT NULL,
          UNIQUE(taskId,generation,ordinal)
        );
        CREATE INDEX creation_progress_task ON creation_progress(taskId,createdAt,id);
        PRAGMA user_version=3;
      `);
      if (version < 4)
        db.exec(`
        CREATE TABLE creation_messages (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES creation_tasks(id), generation INTEGER NOT NULL,
          requestDigest TEXT NOT NULL, payloadDigest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('received','dispatching','delivered','uncertain')), dispatchGeneration INTEGER,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE INDEX creation_messages_task ON creation_messages(taskId,createdAt,id);
        PRAGMA user_version=4;
      `);
      if (version < 5)
        db.exec(`
        CREATE TABLE creation_goals(id TEXT PRIMARY KEY REFERENCES creation_tasks(id),owner TEXT NOT NULL,event TEXT NOT NULL);
        PRAGMA user_version=5;
      `);
      if (version < 6)
        db.exec(`
        CREATE TABLE creation_history_hidden(id TEXT PRIMARY KEY REFERENCES creation_tasks(id),owner TEXT NOT NULL);
        CREATE INDEX creation_history_owner ON creation_history_hidden(owner,id);
        CREATE TABLE creation_history_actions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,createdAt INTEGER NOT NULL);
        PRAGMA user_version=6;
      `);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
