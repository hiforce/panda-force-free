import type { Database } from "bun:sqlite";
import type { KnowledgeGenerationStatus } from "../../../shared/knowledge/generation.js";
import type { KnowledgeGenerationStatusReads } from "../generation/contracts.js";
import { KnowledgeGenerationBudgetStore } from "./generation-budget.js";

/** Read-only queue progress is independent of model execution and uses the same scope as the rule. */
export class KnowledgeGenerationStatusStore implements KnowledgeGenerationStatusReads {
  constructor(private db: Database) {}
  status(owner: string, project: string, now: number): KnowledgeGenerationStatus {
    return this.db.transaction(() => {
      const counts: KnowledgeGenerationStatus["counts"] = {
        observed: 0,
        queued: 0,
        claimed: 0,
        admitted: 0,
        failed: 0,
        excluded: 0,
      };
      for (const row of this.db
        .query<{ state: keyof typeof counts; count: number }, [string, string]>(
          "SELECT state,COUNT(*) count FROM knowledge_generation_jobs WHERE owner=? AND project=? GROUP BY state",
        )
        .all(owner, project))
        counts[row.state] = row.count;
      const dailyUsed =
          this.db
            .query<{ used: number }, [string, string, number]>(
              "SELECT used FROM knowledge_generation_usage WHERE owner=? AND project=? AND day=?",
            )
            .get(owner, project, Math.floor(now / 86400000))?.used ?? 0,
        pendingTasks = this.db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) count FROM knowledge_generation_pending WHERE owner=? AND project=?",
          )
          .get(owner, project)!.count,
        policy = this.db
          .query<
            { scanFailures: number; enabled: number; revision: number; dailyLimit: number; pendingLimit: number },
            [string, string]
          >(
            "SELECT scanFailures,enabled,revision,dailyLimit,pendingLimit FROM knowledge_generation_policies WHERE owner=? AND project=?",
          )
          .get(owner, project);
      return {
        budget: new KnowledgeGenerationBudgetStore(this.db).status(
          owner,
          project,
          policy ?? { dailyLimit: 8, pendingLimit: 4 },
          now,
        ),
        counts,
        dailyUsed,
        pendingTasks,
        sourceUnavailable: !!policy?.scanFailures,
        enabled: policy?.enabled === 1,
        policyRevision: policy?.revision ?? 0,
      };
    })();
  }
}
