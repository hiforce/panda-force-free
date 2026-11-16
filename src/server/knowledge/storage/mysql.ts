import { mysqlAuditGenerationBudgets } from "./mysql-generation-budget-audit.js";
import type { KnowledgeAccessStore } from "../tasks/access.js";
import type { KnowledgePersistence } from "./persistence.js";
import type { SQL } from "bun";
import { DEFAULT_GENERATION_BUDGET } from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeTaskError, type KnowledgeTaskStore } from "../tasks/contracts.js";
import type { KnowledgeReviewStore } from "../review/contracts.js";
import type { KnowledgeCatalog } from "../catalog/contracts.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { MySQLMetadataContext } from "./mysql-context.js";
import { MySQLKnowledgeTaskRecords } from "./mysql-records.js";
import { MySQLKnowledgeTaskSubmissionsStore } from "./mysql-submissions.js";
import { MySQLKnowledgeTaskExecutions } from "./mysql-executions.js";
import { MySQLKnowledgeTaskReviews } from "./mysql-reviews.js";
import { MySQLKnowledgeTaskDelivery } from "./mysql-delivery.js";
import { MySQLKnowledgeReviewPoliciesStore } from "./mysql-review-policies.js";
import { MySQLKnowledgeReviewExecutionsStore } from "./mysql-review-executions.js";
import { MySQLKnowledgeReviewDecisionsStore } from "./mysql-review-decisions.js";
import { MySQLKnowledgeCatalogStore } from "./mysql-catalog.js";
import { MySQLKnowledgeGenerationPolicies } from "./mysql-generation-policies.js";
import { MySQLKnowledgeGenerationQueue } from "./mysql-generation-queue.js";
import { MySQLKnowledgeGenerationAdmission } from "./mysql-generation-admission.js";
import { MySQLKnowledgeGenerationStatusStore } from "./mysql-generation-status.js";
import { mysqlConfigureGenerationBudgets } from "./mysql-generation-budget.js";
import { MySQLKnowledgeAccessScopes } from "./mysql-access.js";
/** Keep derived active-budget rows in the same transaction as every task transition, including replays and retries. */
async function maintainPending(db: MySQLMetadataContext) {
  await db.execute(`DELETE p FROM panda_force_knowledge_generation_pending p
    LEFT JOIN panda_force_knowledge_tasks t ON t.id=p.taskId
    LEFT JOIN panda_force_knowledge_generation_origins g ON g.taskId=p.taskId
    WHERE t.id IS NULL OR g.taskId IS NULL OR t.state NOT IN ('queued','running','waiting','review','committing')`);
  const missing = await db.all<{ taskId: string; owner: string; project: string }>(`SELECT t.id taskId,t.owner,t.project
    FROM panda_force_knowledge_tasks t JOIN panda_force_knowledge_generation_origins g ON g.taskId=t.id
    LEFT JOIN panda_force_knowledge_generation_pending p ON p.taskId=t.id
    WHERE p.taskId IS NULL AND t.state IN ('queued','running','waiting','review','committing')`);

  for (const row of missing) {
    const policy = await db.one<{ dailyLimit: number; pendingLimit: number }>(
      "SELECT dailyLimit,pendingLimit FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=?",
      [row.owner, row.project],
    );
    if (!policy) throw new KnowledgeTaskError("budget");
    const limits = await db.one<{ installationPending: number; ownerPending: number }>(
      "SELECT installationPending,ownerPending FROM panda_force_knowledge_generation_limits WHERE id=1",
    );
    if (!limits) throw new KnowledgeTaskError("unavailable");
    const counts = await db.one<{ total: number; owned: number; projectCount: number }>(
      `SELECT COUNT(*) total,
      COALESCE(SUM(owner=?),0) owned,COALESCE(SUM(owner=? AND project=?),0) projectCount FROM panda_force_knowledge_generation_pending`,
      [row.owner, row.owner, row.project],
    );
    if (
      Number(counts!.total) >= limits.installationPending ||
      Number(counts!.owned) >= limits.ownerPending ||
      Number(counts!.projectCount) >= policy.pendingLimit
    )
      throw new KnowledgeTaskError("budget");
    await db.execute("INSERT INTO panda_force_knowledge_generation_pending(taskId,owner,project) VALUES(?,?,?)", [
      row.taskId,
      row.owner,
      row.project,
    ]);
  }
}
function bind<T extends object>(db: MySQLMetadataContext, target: T, methods: readonly (keyof T)[]) {
  return Object.fromEntries(
    methods.map((name) => [
      name,
      async (...args: unknown[]) =>
        db.atomic(async () => {
          const result = await (target[name] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          await maintainPending(db);
          return result;
        }),
    ]),
  );
}
/** All facets share one native Bun SQL transaction context; the caller owns the pool and schema lifecycle. */
export async function createMySQLKnowledgePersistence(sql: SQL): Promise<KnowledgePersistence> {
  const db = new MySQLMetadataContext(sql, "knowledge"),
    records = new MySQLKnowledgeTaskRecords(db),
    submissions = new MySQLKnowledgeTaskSubmissionsStore(db, records),
    executions = new MySQLKnowledgeTaskExecutions(db, records),
    reviews = new MySQLKnowledgeTaskReviews(db, records, executions),
    delivery = new MySQLKnowledgeTaskDelivery(db, records);
  const defaults = DEFAULT_GENERATION_BUDGET;
  await db.execute(
    `INSERT INTO panda_force_knowledge_generation_limits(id,installationDaily,ownerDaily,installationPending,ownerPending)
    VALUES(1,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
    [defaults.installationDaily, defaults.ownerDaily, defaults.installationPending, defaults.ownerPending],
  );
  const ledger = {
    ...bind(db, records, ["get", "list", "page", "submission"]),
    ...bind(db, submissions, ["create"]),
    ...bind(db, executions, [
      "claim",
      "assertLease",
      "assertExecution",
      "bind",
      "heartbeat",
      "fail",
      "release",
      "retry",
    ]),
    ...bind(db, reviews, ["question", "draft", "answer", "edit", "admit", "cancel"]),
    ...bind(db, delivery, ["denyDelivery", "complete", "outputFailed", "retryOutput", "nextOutput", "rejectDelivery"]),
  } as AsyncMetadataStore<KnowledgeTaskStore>;
  const policies = new MySQLKnowledgeReviewPoliciesStore(db),
    execution = new MySQLKnowledgeReviewExecutionsStore(db, records),
    decisions = new MySQLKnowledgeReviewDecisionsStore(db);
  const review = {
    ...bind(db, policies, ["policy", "configure"]),
    ...bind(db, execution, ["claim", "assert", "bind", "heartbeat", "fail"]),
    ...bind(db, decisions, ["latest", "latestFor", "finish", "admit", "pending"]),
  } as AsyncMetadataStore<KnowledgeReviewStore>;
  return {
    ledger,
    reviews: review,
    catalog: new MySQLKnowledgeCatalogStore(db) as AsyncMetadataStore<KnowledgeCatalog>,
    access: bind(db, new MySQLKnowledgeAccessScopes(db), [
      "next",
      "revoke",
    ]) as AsyncMetadataStore<KnowledgeAccessStore>,
    generation: {
      policies: new MySQLKnowledgeGenerationPolicies(db, ledger),
      queue: new MySQLKnowledgeGenerationQueue(db, ledger),
      admission: new MySQLKnowledgeGenerationAdmission(db),
      status: new MySQLKnowledgeGenerationStatusStore(db),
      auditBudgets: () => mysqlAuditGenerationBudgets(db),
      configureBudgets: (input: Parameters<typeof mysqlConfigureGenerationBudgets>[1]) =>
        mysqlConfigureGenerationBudgets(db, input),
    },
  };
}
