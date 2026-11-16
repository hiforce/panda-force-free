import type { Database } from "bun:sqlite";
import {
  generationBudgetLimits,
  type KnowledgeGenerationBudgetLimits,
  type GenerationBudgetBlock,
  type KnowledgeGenerationBudgetStatus,
} from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

type RuleLimits = { dailyLimit: number; pendingLimit: number };
/** Only the trusted application composition imports administrator configuration. Reads never reset persisted limits. */
export function configureGenerationBudgets(db: Database, input: KnowledgeGenerationBudgetLimits) {
  const limits = generationBudgetLimits(input);
  db.query(
    `INSERT INTO knowledge_generation_limits VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET installationDaily=excluded.installationDaily,
       ownerDaily=excluded.ownerDaily,installationPending=excluded.installationPending,ownerPending=excluded.ownerPending`,
  ).run(limits.installationDaily, limits.ownerDaily, limits.installationPending, limits.ownerPending);
}
export function generationBudgetFailure(error: unknown) {
  return error instanceof Error && error.message === "knowledge_generation_budget";
}
/** Admission and its aggregates share the enclosing task transaction; replay never charges a second time. */
export class KnowledgeGenerationBudgetStore {
  constructor(private db: Database) {}
  private limits() {
    const value = this.db
      .query<KnowledgeGenerationBudgetLimits, []>(
        "SELECT installationDaily,ownerDaily,installationPending,ownerPending FROM knowledge_generation_limits WHERE id=1",
      )
      .get();
    if (!value) throw new KnowledgeTaskError("unavailable");
    return value;
  }
  usage(owner: string, project: string, now: number) {
    return (
      this.db
        .query<{ used: number }, [string, string, number]>(
          "SELECT used FROM knowledge_generation_usage WHERE owner=? AND project=? AND day=?",
        )
        .get(owner, project, Math.floor(now / 86400000))?.used ?? 0
    );
  }
  private total(scope: "owner" | "installation", owner: string, now: number) {
    return (
      this.db
        .query<{ used: number }, [string, string, number]>(
          "SELECT used FROM knowledge_generation_totals WHERE scope=? AND identity=? AND day=?",
        )
        .get(scope, scope === "installation" ? "" : owner, Math.floor(now / 86400000))?.used ?? 0
    );
  }
  private count(owner?: string, project?: string) {
    const where = owner !== undefined ? " WHERE owner=?" + (project !== undefined ? " AND project=?" : "") : "";
    return this.db
      .query<{ count: number }, string[]>("SELECT COUNT(*) count FROM knowledge_generation_pending" + where)
      .get(...(owner === undefined ? [] : project === undefined ? [owner] : [owner, project]))!.count;
  }
  status(owner: string, project: string, policy: RuleLimits, now: number): KnowledgeGenerationBudgetStatus {
    const limits = this.limits(),
      ownerDailyUsed = this.total("owner", owner, now),
      ownerPending = this.count(owner);
    let blocked: GenerationBudgetBlock | null = null;
    if (this.usage(owner, project, now) >= policy.dailyLimit) blocked = "projectDaily";
    else if (this.count(owner, project) >= policy.pendingLimit) blocked = "projectPending";
    else if (ownerDailyUsed >= limits.ownerDaily) blocked = "ownerDaily";
    else if (ownerPending >= limits.ownerPending) blocked = "ownerPending";
    else if (this.total("installation", owner, now) >= limits.installationDaily) blocked = "installationDaily";
    else if (this.count() >= limits.installationPending) blocked = "installationPending";
    return { limits, ownerDailyUsed, ownerPending, blocked };
  }
  assert(owner: string, project: string, policy: RuleLimits, now: number) {
    if (this.status(owner, project, policy, now).blocked) throw new KnowledgeTaskError("budget");
  }
  charge(owner: string, project: string, now: number) {
    const day = Math.floor(now / 86400000);
    this.db
      .query(
        "INSERT INTO knowledge_generation_usage VALUES(?,?,?,1) ON CONFLICT(owner,project,day) DO UPDATE SET used=used+1",
      )
      .run(owner, project, day);
  }
  retryAt(owner: string, project: string, projectDailyLimit: number, now: number) {
    const limits = this.limits(),
      daily =
        this.usage(owner, project, now) >= projectDailyLimit ||
        this.total("owner", owner, now) >= limits.ownerDaily ||
        this.total("installation", owner, now) >= limits.installationDaily;
    return daily ? (Math.floor(now / 86400000) + 1) * 86400000 : now + 15000;
  }
}
