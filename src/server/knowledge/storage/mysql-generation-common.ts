import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { GENERATION_LIMITS } from "../../../shared/knowledge/generation.js";
import type { GenerationLease, GenerationSourceIdentity, GenerationSnapshot } from "../generation/contracts.js";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";
export async function mysqlGenerationLeaseCurrent(db: MySQLMetadataContext, lease: GenerationLease, now: number) {
  return !!(await db.one(
    `SELECT 1 FROM panda_force_knowledge_generation_jobs j
    JOIN panda_force_knowledge_generation_policies p ON p.owner=j.owner AND p.project=j.project
    WHERE j.owner=? AND j.project=? AND j.documentId=? AND j.sourceKind=? AND j.version=? AND j.policyRevision=?
    AND j.operationId=? AND j.token=? AND j.state='claimed' AND j.leaseUntil>?
    AND p.enabled=1 AND p.revision=j.policyRevision`,
    [
      lease.owner,
      lease.project,
      lease.source.id,
      lease.source.kind,
      lease.source.version,
      lease.policyRevision,
      lease.operationId,
      lease.token,
      now,
    ],
  ));
}
/** A scope with no pending work leaves the dispatch index; two indexed minima avoid sorting every due job. */
export async function mysqlScheduleGenerationScope(
  db: MySQLMetadataContext,
  owner: string,
  project: string,
  floor: number,
) {
  const ready = (await db.one<{
      due: number | null;
    }>(
      "SELECT MIN(notBefore) due FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? AND state='queued'",
      [owner, project],
    ))!.due,
    expired = (await db.one<{
      due: number | null;
    }>(
      "SELECT MIN(leaseUntil) due FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? AND state='claimed'",
      [owner, project],
    ))!.due,
    times = [ready, expired].filter((value): value is number => value !== null),
    next = times.length ? Math.max(floor, Math.min(...times)) : null;
  await db.execute(
    "UPDATE panda_force_knowledge_generation_policies SET nextAdmissionAt=? WHERE owner=? AND project=?",
    [next, owner, project],
  );
}
/** Policy replacement cannot cancel manual tasks or undo an already admitted file/Git save. */
export async function mysqlCancelGeneratedTasks(
  db: MySQLMetadataContext,
  tasks: Pick<AsyncMetadataStore<KnowledgeTaskStore>, "cancel">,
  owner: string,
  project: string,
  now: number,
  source?: Pick<GenerationSourceIdentity, "id" | "kind">,
) {
  const rows = await db.all<{
    taskId: string;
  }>(
    `SELECT g.taskId FROM panda_force_knowledge_tasks t
    CROSS JOIN panda_force_knowledge_generation_origins g WHERE g.taskId=t.id AND t.owner=? AND t.project=?
    AND g.manual=0 AND t.state IN ('queued','running','waiting','review') ${source ? "AND g.documentId=? AND g.sourceKind=?" : ""}`,
    [owner, project, ...(source ? [source.id, source.kind] : [])],
  );
  for (const { taskId } of rows) {
    await tasks.cancel(owner, taskId, now);
    await db.execute(
      "UPDATE panda_force_knowledge_reviews SET state='superseded',finishedAt=? WHERE taskId=? AND state IN ('running','passed')",
      [now, taskId],
    );
  }
  return rows.map((row) => row.taskId);
}
/** Convert only a caller-validated complete metadata set; persistence acquires no workflow/source-reading authority. */
export function generationSnapshotSources(snapshot: GenerationSnapshot): GenerationSourceIdentity[] {
  const rows = [
    ...snapshot.documents.map(({ id, version }) => ({ id, version, kind: "document" as const })),
    ...(snapshot.originals ?? []),
  ];
  if (rows.length > GENERATION_LIMITS.documents) throw new KnowledgeTaskError("budget");
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new KnowledgeTaskError("conflict");
  return rows;
}
