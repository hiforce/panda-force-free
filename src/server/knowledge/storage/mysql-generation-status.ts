import type { MySQLMetadataContext } from "./mysql-context.js";

import type { KnowledgeGenerationStatus } from "../../../shared/knowledge/generation.js";

import { MySQLKnowledgeGenerationBudgetStore } from "./mysql-generation-budget.js";
/** Read-only queue progress is independent of model execution and uses the same scope as the rule. */
export class MySQLKnowledgeGenerationStatusStore {
  constructor(private db: MySQLMetadataContext) {}
  async status(owner: string, project: string, now: number): Promise<KnowledgeGenerationStatus> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const counts: KnowledgeGenerationStatus["counts"] = {
          observed: 0,
          queued: 0,
          claimed: 0,
          admitted: 0,
          failed: 0,
          excluded: 0,
        };
        for (const row of await this.db.all<{
          state: keyof typeof counts;
          count: number;
        }>(
          "SELECT state,COUNT(*) count FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? GROUP BY state",
          [owner, project],
        ))
          counts[row.state] = row.count;
        const dailyUsed =
            (
              await this.db.one<{
                used: number;
              }>("SELECT used FROM panda_force_knowledge_generation_usage WHERE owner=? AND project=? AND day=?", [
                owner,
                project,
                Math.floor(now / 86400000),
              ])
            )?.used ?? 0,
          pendingTasks = (await this.db.one<{
            count: number;
          }>("SELECT COUNT(*) count FROM panda_force_knowledge_generation_pending WHERE owner=? AND project=?", [
            owner,
            project,
          ]))!.count,
          policy = await this.db.one<{
            scanFailures: number;
            enabled: number;
            revision: number;
            dailyLimit: number;
            pendingLimit: number;
          }>(
            "SELECT scanFailures,enabled,revision,dailyLimit,pendingLimit FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=?",
            [owner, project],
          );
        return {
          budget: await new MySQLKnowledgeGenerationBudgetStore(this.db).status(
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
      });
    });
  }
}
