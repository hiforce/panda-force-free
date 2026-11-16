import type { Database } from "bun:sqlite";
import type { GenerationLease, KnowledgeGenerationAdmissions } from "../generation/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { generationLeaseCurrent, scheduleGenerationScope } from "./generation-common.js";
import { KnowledgeGenerationBudgetStore, generationBudgetFailure } from "./generation-budget.js";

/** Called only inside task insertion: the policy/lease, quota, origin and task link commit or roll back together. */
export class KnowledgeGenerationAdmission implements KnowledgeGenerationAdmissions {
  private budget: KnowledgeGenerationBudgetStore;
  constructor(private db: Database) {
    this.budget = new KnowledgeGenerationBudgetStore(db);
  }
  usage(owner: string, project: string, now: number) {
    return this.budget.usage(owner, project, now);
  }
  admit(lease: GenerationLease, taskId: string, created: boolean, now: number) {
    try {
      return this.db.transaction(() => this.commit(lease, taskId, created, now)).immediate();
    } catch (error) {
      if (generationBudgetFailure(error)) throw new KnowledgeTaskError("budget");
      throw error;
    }
  }
  private commit(lease: GenerationLease, taskId: string, created: boolean, now: number) {
    if (!generationLeaseCurrent(this.db, lease, now)) throw new KnowledgeTaskError("leaseLost");
    if (
      !this.db
        .query("SELECT 1 FROM knowledge_tasks WHERE id=? AND owner=? AND project=?")
        .get(taskId, lease.owner, lease.project)
    )
      throw new KnowledgeTaskError("conflict");
    const policy = this.db
      .query<{ dailyLimit: number; pendingLimit: number }, [string, string]>(
        "SELECT dailyLimit,pendingLimit FROM knowledge_generation_policies WHERE owner=? AND project=?",
      )
      .get(lease.owner, lease.project)!;
    if (created) {
      this.budget.assert(lease.owner, lease.project, policy, now);
      this.budget.charge(lease.owner, lease.project, now);
      this.db
        .query(
          "INSERT INTO knowledge_generation_origins(taskId,owner,project,documentId,version,policyRevision,createdAt,sourceKind) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          taskId,
          lease.owner,
          lease.project,
          lease.source.id,
          lease.source.version,
          lease.policyRevision,
          now,
          lease.source.kind,
        );
    }
    this.db
      .query(
        "UPDATE knowledge_generation_jobs SET state='admitted',token=NULL,leaseUntil=NULL,taskId=?,updatedAt=? WHERE owner=? AND project=? AND documentId=? AND token=?",
      )
      .run(taskId, now, lease.owner, lease.project, lease.source.id, lease.token);
    scheduleGenerationScope(this.db, lease.owner, lease.project, now + 2000);
  }
  retryAt(owner: string, project: string, dailyLimit: number, now: number) {
    return this.budget.retryAt(owner, project, dailyLimit, now);
  }
}
