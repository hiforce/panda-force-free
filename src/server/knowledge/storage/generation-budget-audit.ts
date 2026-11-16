import type { Database } from "bun:sqlite";
import { generationBudgetLimits } from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { GENERATION_BUDGET_GUARDS } from "./generation-budget-guards.js";

const totals = `SELECT 'installation' scope,'' identity,day,SUM(used) used FROM knowledge_generation_usage GROUP BY day
  UNION ALL SELECT 'owner',owner,day,SUM(used) FROM knowledge_generation_usage GROUP BY owner,day ORDER BY scope,identity,day`,
  pending = `SELECT t.id taskId,t.owner,t.project FROM knowledge_tasks t INDEXED BY knowledge_queue
  CROSS JOIN knowledge_generation_origins g WHERE g.taskId=t.id AND t.state IN ('queued','running','waiting','review','committing') ORDER BY t.id`,
  pendingIndex = "CREATE INDEX knowledge_generation_pending_owner ON knowledge_generation_pending(owner,project)";
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ").replace(/;$/, "");

/** Derived quota metadata can be repaired automatically; primary task history and retained usage never change. */
export function auditGenerationBudgets(db: Database) {
  return db
    .transaction(() => {
      const limits = db
        .query(
          "SELECT installationDaily,ownerDaily,installationPending,ownerPending FROM knowledge_generation_limits WHERE id=1",
        )
        .get();
      if (!limits) throw new KnowledgeTaskError("unavailable");
      generationBudgetLimits(limits);
      const expectedTotals = db.query(totals).all(),
        expectedPending = db.query(pending).all(),
        totalsChanged =
          JSON.stringify(expectedTotals) !==
          JSON.stringify(db.query("SELECT * FROM knowledge_generation_totals ORDER BY scope,identity,day").all()),
        pendingChanged =
          JSON.stringify(expectedPending) !==
          JSON.stringify(db.query("SELECT * FROM knowledge_generation_pending ORDER BY taskId").all()),
        schema = [...GENERATION_BUDGET_GUARDS, pendingIndex],
        changed = schema.some((sql) => {
          const name = sql.match(/^CREATE (?:TRIGGER|INDEX) (\w+)/)![1]!,
            actual = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql;
          return !actual || normalize(actual) !== normalize(sql);
        });
      if (!totalsChanged && !pendingChanged && !changed) return { repaired: false };
      // Schema removal and restoration share one immediate transaction; no writer can observe an unguarded interval.
      for (const sql of GENERATION_BUDGET_GUARDS)
        db.exec("DROP TRIGGER IF EXISTS " + sql.match(/^CREATE TRIGGER (\w+)/)![1]);
      if (totalsChanged) {
        db.exec("DELETE FROM knowledge_generation_totals");
        db.exec("INSERT INTO knowledge_generation_totals " + totals);
      }
      if (pendingChanged) {
        db.exec("DELETE FROM knowledge_generation_pending");
        db.exec("INSERT INTO knowledge_generation_pending " + pending);
      }
      db.exec("DROP INDEX IF EXISTS knowledge_generation_pending_owner");
      db.exec(pendingIndex);
      for (const sql of GENERATION_BUDGET_GUARDS) db.exec(sql);
      return { repaired: true };
    })
    .immediate();
}
