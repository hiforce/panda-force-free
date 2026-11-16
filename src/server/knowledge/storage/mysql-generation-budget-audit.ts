import type { MySQLMetadataContext } from "./mysql-context.js";
import { generationBudgetLimits } from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
/** Repair only derived aggregates under the module fence. Retained usage, task history and administrator limits stay authoritative. */
export async function mysqlAuditGenerationBudgets(db: MySQLMetadataContext) {
  return db.atomic(async () => {
    const limits = await db.one(
      "SELECT installationDaily,ownerDaily,installationPending,ownerPending FROM panda_force_knowledge_generation_limits WHERE id=1",
    );
    if (!limits) throw new KnowledgeTaskError("unavailable");
    generationBudgetLimits(limits);
    const totals = `SELECT 'installation' scope,'' identity,day,SUM(used) used FROM panda_force_knowledge_generation_usage GROUP BY day
    UNION ALL SELECT 'owner',owner,day,SUM(used) FROM panda_force_knowledge_generation_usage GROUP BY owner,day ORDER BY scope,identity,day`,
      pending = `SELECT t.id taskId,t.owner,t.project FROM panda_force_knowledge_tasks t
    JOIN panda_force_knowledge_generation_origins g ON g.taskId=t.id WHERE t.state IN ('queued','running','waiting','review','committing') ORDER BY t.id`;
    const expectedTotals = await db.all(totals),
      expectedPending = await db.all(pending),
      totalsChanged =
        JSON.stringify(expectedTotals) !==
        JSON.stringify(
          await db.all(
            "SELECT scope,identity,day,used FROM panda_force_knowledge_generation_totals ORDER BY scope,identity,day",
          ),
        ),
      pendingChanged =
        JSON.stringify(expectedPending) !==
        JSON.stringify(
          await db.all("SELECT taskId,owner,project FROM panda_force_knowledge_generation_pending ORDER BY taskId"),
        );
    if (totalsChanged) {
      await db.execute("DELETE FROM panda_force_knowledge_generation_totals");
      await db.execute("INSERT INTO panda_force_knowledge_generation_totals(scope,identity,day,used) " + totals);
    }
    if (pendingChanged) {
      await db.execute("DELETE FROM panda_force_knowledge_generation_pending");
      await db.execute("INSERT INTO panda_force_knowledge_generation_pending(taskId,owner,project) " + pending);
    }
    return { repaired: totalsChanged || pendingChanged };
  });
}
