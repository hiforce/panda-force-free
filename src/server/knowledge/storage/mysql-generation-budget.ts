import type { MySQLMetadataContext } from "./mysql-context.js";

import {
  generationBudgetLimits,
  type KnowledgeGenerationBudgetLimits,
  type GenerationBudgetBlock,
  type KnowledgeGenerationBudgetStatus,
} from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
type RuleLimits = {
  dailyLimit: number;
  pendingLimit: number;
};
/** Only the trusted application composition imports administrator configuration. Reads never reset persisted limits. */
export async function mysqlConfigureGenerationBudgets(
  db: MySQLMetadataContext,
  input: KnowledgeGenerationBudgetLimits,
) {
  const limits = generationBudgetLimits(input);
  await db.execute(
    `INSERT INTO panda_force_knowledge_generation_limits VALUES(1,?,?,?,?) ON DUPLICATE KEY UPDATE installationDaily=VALUES(installationDaily),
       ownerDaily=VALUES(ownerDaily),installationPending=VALUES(installationPending),ownerPending=VALUES(ownerPending)`,
    [limits.installationDaily, limits.ownerDaily, limits.installationPending, limits.ownerPending],
  );
}
export function generationBudgetFailure(error: unknown) {
  return error instanceof Error && error.message === "panda_force_knowledge_generation_budget";
}
/** Admission and its aggregates share the enclosing task transaction; replay never charges a second time. */
export class MySQLKnowledgeGenerationBudgetStore {
  constructor(private db: MySQLMetadataContext) {}
  private async limits() {
    return await this.db.atomic(async () => {
      const value = await this.db.one<KnowledgeGenerationBudgetLimits>(
        "SELECT installationDaily,ownerDaily,installationPending,ownerPending FROM panda_force_knowledge_generation_limits WHERE id=1",
        [],
      );
      if (!value) throw new KnowledgeTaskError("unavailable");
      return value;
    });
  }
  async usage(owner: string, project: string, now: number) {
    return await this.db.atomic(async () => {
      return (
        (
          await this.db.one<{
            used: number;
          }>("SELECT used FROM panda_force_knowledge_generation_usage WHERE owner=? AND project=? AND day=?", [
            owner,
            project,
            Math.floor(now / 86400000),
          ])
        )?.used ?? 0
      );
    });
  }
  private async total(scope: "owner" | "installation", owner: string, now: number) {
    return await this.db.atomic(async () => {
      return (
        (
          await this.db.one<{
            used: number;
          }>("SELECT used FROM panda_force_knowledge_generation_totals WHERE scope=? AND identity=? AND day=?", [
            scope,
            scope === "installation" ? "" : owner,
            Math.floor(now / 86400000),
          ])
        )?.used ?? 0
      );
    });
  }
  private async count(owner?: string, project?: string) {
    return await this.db.atomic(async () => {
      const where = owner !== undefined ? " WHERE owner=?" + (project !== undefined ? " AND project=?" : "") : "";
      return (await this.db.one<{
        count: number;
      }>("SELECT COUNT(*) count FROM panda_force_knowledge_generation_pending" + where, [
        ...(owner === undefined ? [] : project === undefined ? [owner] : [owner, project]),
      ]))!.count;
    });
  }
  async status(
    owner: string,
    project: string,
    policy: RuleLimits,
    now: number,
  ): Promise<KnowledgeGenerationBudgetStatus> {
    return await this.db.atomic(async () => {
      const limits = await this.limits(),
        ownerDailyUsed = await this.total("owner", owner, now),
        ownerPending = await this.count(owner);
      let blocked: GenerationBudgetBlock | null = null;
      if ((await this.usage(owner, project, now)) >= policy.dailyLimit) blocked = "projectDaily";
      else if ((await this.count(owner, project)) >= policy.pendingLimit) blocked = "projectPending";
      else if (ownerDailyUsed >= limits.ownerDaily) blocked = "ownerDaily";
      else if (ownerPending >= limits.ownerPending) blocked = "ownerPending";
      else if ((await this.total("installation", owner, now)) >= limits.installationDaily)
        blocked = "installationDaily";
      else if ((await this.count()) >= limits.installationPending) blocked = "installationPending";
      return { limits, ownerDailyUsed, ownerPending, blocked };
    });
  }
  async assert(owner: string, project: string, policy: RuleLimits, now: number) {
    return await this.db.atomic(async () => {
      if ((await this.status(owner, project, policy, now)).blocked) throw new KnowledgeTaskError("budget");
    });
  }
  async charge(owner: string, project: string, now: number) {
    return await this.db.atomic(async () => {
      const day = Math.floor(now / 86400000);
      await this.db.execute(
        "INSERT INTO panda_force_knowledge_generation_usage(owner,project,day,used) VALUES(?,?,?,1) ON DUPLICATE KEY UPDATE used=used+1",
        [owner, project, day],
      );
      await this.db.execute(
        "INSERT INTO panda_force_knowledge_generation_totals(scope,identity,day,used) VALUES('installation','',?,1) ON DUPLICATE KEY UPDATE used=used+1",
        [day],
      );
      await this.db.execute(
        "INSERT INTO panda_force_knowledge_generation_totals(scope,identity,day,used) VALUES('owner',?,?,1) ON DUPLICATE KEY UPDATE used=used+1",
        [owner, day],
      );
    });
  }
  async retryAt(owner: string, project: string, projectDailyLimit: number, now: number) {
    return await this.db.atomic(async () => {
      const limits = await this.limits(),
        daily =
          (await this.usage(owner, project, now)) >= projectDailyLimit ||
          (await this.total("owner", owner, now)) >= limits.ownerDaily ||
          (await this.total("installation", owner, now)) >= limits.installationDaily;
      return daily ? (Math.floor(now / 86400000) + 1) * 86400000 : now + 15000;
    });
  }
}
