import { Database } from "bun:sqlite";

/** Disposable native storage mirrors the installed protocol; it never opens an application or user database. */
export function seedGoalFixture(path, goals) {
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,goal_id TEXT NOT NULL,objective TEXT NOT NULL,status TEXT NOT NULL,
      token_budget INTEGER,tokens_used INTEGER NOT NULL DEFAULT 0,time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)`);
    for (const goal of goals)
      db.query("INSERT INTO thread_goals VALUES(?,?,?,?,?,?,?,?,?)").run(
        goal.threadId,
        goal.goalId,
        goal.objective,
        goal.status,
        goal.tokenBudget ?? null,
        goal.tokensUsed ?? 0,
        goal.timeUsedSeconds ?? 0,
        goal.createdAt ?? Date.now(),
        goal.updatedAt ?? Date.now(),
      );
  } finally {
    db.close();
  }
}
