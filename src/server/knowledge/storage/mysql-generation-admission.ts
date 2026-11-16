import type { MySQLMetadataContext } from "./mysql-context.js";

import type { GenerationLease } from "../generation/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { mysqlGenerationLeaseCurrent, mysqlScheduleGenerationScope } from "./mysql-generation-common.js";
import { MySQLKnowledgeGenerationBudgetStore, generationBudgetFailure } from "./mysql-generation-budget.js";
/** Called only inside task insertion: the policy/lease, quota, origin and task link commit or roll back together. */
export class MySQLKnowledgeGenerationAdmission {
  private budget: MySQLKnowledgeGenerationBudgetStore;
  constructor(private db: MySQLMetadataContext) {
    this.budget = new MySQLKnowledgeGenerationBudgetStore(db);
  }
  async usage(owner: string, project: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.budget.usage(owner, project, now);
    });
  }
  async admit(lease: GenerationLease, taskId: string, created: boolean, now: number) {
    return await this.db.atomic(async () => {
      try {
        return await this.db.atomic(async () => await this.commit(lease, taskId, created, now));
      } catch (error) {
        if (generationBudgetFailure(error)) throw new KnowledgeTaskError("budget");
        throw error;
      }
    });
  }
  private async commit(lease: GenerationLease, taskId: string, created: boolean, now: number) {
    return await this.db.atomic(async () => {
      if (!(await mysqlGenerationLeaseCurrent(this.db, lease, now))) throw new KnowledgeTaskError("leaseLost");
      if (
        !(await this.db.one("SELECT 1 FROM panda_force_knowledge_tasks WHERE id=? AND owner=? AND project=?", [
          taskId,
          lease.owner,
          lease.project,
        ]))
      )
        throw new KnowledgeTaskError("conflict");
      const policy = (await this.db.one<{
        dailyLimit: number;
        pendingLimit: number;
      }>("SELECT dailyLimit,pendingLimit FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=?", [
        lease.owner,
        lease.project,
      ]))!;
      if (created) {
        await this.budget.assert(lease.owner, lease.project, policy, now);
        await this.budget.charge(lease.owner, lease.project, now);
        await this.db.execute(
          "INSERT INTO panda_force_knowledge_generation_origins(taskId,owner,project,documentId,version,policyRevision,createdAt,sourceKind) VALUES(?,?,?,?,?,?,?,?)",
          [
            taskId,
            lease.owner,
            lease.project,
            lease.source.id,
            lease.source.version,
            lease.policyRevision,
            now,
            lease.source.kind,
          ],
        );
      }
      await this.db.execute(
        "UPDATE panda_force_knowledge_generation_jobs SET state='admitted',token=NULL,leaseUntil=NULL,taskId=?,updatedAt=? WHERE owner=? AND project=? AND documentId=? AND token=?",
        [taskId, now, lease.owner, lease.project, lease.source.id, lease.token],
      );
      await mysqlScheduleGenerationScope(this.db, lease.owner, lease.project, now + 2000);
    });
  }
  async retryAt(owner: string, project: string, dailyLimit: number, now: number) {
    return await this.db.atomic(async () => {
      return await this.budget.retryAt(owner, project, dailyLimit, now);
    });
  }
}
