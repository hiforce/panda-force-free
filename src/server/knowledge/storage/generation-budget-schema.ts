import type { Database } from "bun:sqlite";
import { GENERATION_BUDGET_GUARDS } from "./generation-budget-guards.js";
import { DEFAULT_GENERATION_BUDGET } from "../../../shared/knowledge/generation-budget.js";

/** Rebuild aggregates once from retained usage; task-state triggers maintain only the bounded active set. */
export function migrateGenerationBudgets(db: Database) {
  db.exec(`
    CREATE TABLE knowledge_generation_limits (
      id INTEGER PRIMARY KEY CHECK(id=1),installationDaily INTEGER NOT NULL CHECK(installationDaily BETWEEN 0 AND 100000),
      ownerDaily INTEGER NOT NULL CHECK(ownerDaily BETWEEN 0 AND installationDaily),
      installationPending INTEGER NOT NULL CHECK(installationPending BETWEEN 0 AND 100000),
      ownerPending INTEGER NOT NULL CHECK(ownerPending BETWEEN 0 AND installationPending)
    );
    CREATE TABLE knowledge_generation_totals (
      scope TEXT NOT NULL CHECK(scope IN ('installation','owner')), identity TEXT NOT NULL,
      day INTEGER NOT NULL, used INTEGER NOT NULL CHECK(used>=0),
      PRIMARY KEY(scope,identity,day), CHECK(scope!='installation' OR identity='')
    );
    INSERT INTO knowledge_generation_totals SELECT 'installation','',day,SUM(used) FROM knowledge_generation_usage GROUP BY day;
    INSERT INTO knowledge_generation_totals SELECT 'owner',owner,day,SUM(used) FROM knowledge_generation_usage GROUP BY owner,day;
    CREATE TABLE knowledge_generation_pending (
      taskId TEXT PRIMARY KEY REFERENCES knowledge_tasks(id),owner TEXT NOT NULL,project TEXT NOT NULL
    );
    CREATE INDEX knowledge_generation_pending_owner ON knowledge_generation_pending(owner,project);
    INSERT INTO knowledge_generation_pending SELECT t.id,t.owner,t.project FROM knowledge_tasks t
      JOIN knowledge_generation_origins g ON g.taskId=t.id WHERE t.state IN ('queued','running','waiting','review','committing');
    PRAGMA user_version=5;
  `);
  const limits = DEFAULT_GENERATION_BUDGET;
  db.query("INSERT INTO knowledge_generation_limits VALUES(1,?,?,?,?)").run(
    limits.installationDaily,
    limits.ownerDaily,
    limits.installationPending,
    limits.ownerPending,
  );
  for (const sql of GENERATION_BUDGET_GUARDS) db.exec(sql);
}
