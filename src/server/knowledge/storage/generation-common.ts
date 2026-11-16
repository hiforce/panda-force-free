import { KnowledgeTaskError } from "../tasks/contracts.js";
import { GENERATION_LIMITS } from "../../../shared/knowledge/generation.js";
import type { Database } from "bun:sqlite";
import type { GenerationLease, GenerationSourceIdentity, GenerationSnapshot } from "../generation/contracts.js";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";

export function generationLeaseCurrent(db: Database, lease: GenerationLease, now: number) {
  return !!db
    .query(
      `SELECT 1 FROM knowledge_generation_jobs j
    JOIN knowledge_generation_policies p ON p.owner=j.owner AND p.project=j.project
    WHERE j.owner=? AND j.project=? AND j.documentId=? AND j.sourceKind=? AND j.version=? AND j.policyRevision=?
    AND j.operationId=? AND j.token=? AND j.state='claimed' AND j.leaseUntil>?
    AND p.enabled=1 AND p.revision=j.policyRevision`,
    )
    .get(
      lease.owner,
      lease.project,
      lease.source.id,
      lease.source.kind,
      lease.source.version,
      lease.policyRevision,
      lease.operationId,
      lease.token,
      now,
    );
}

/** A scope with no pending work leaves the dispatch index; two indexed minima avoid sorting every due job. */
export function scheduleGenerationScope(db: Database, owner: string, project: string, floor: number) {
  const ready = db
      .query<{ due: number | null }, [string, string]>(
        "SELECT MIN(notBefore) due FROM knowledge_generation_jobs WHERE owner=? AND project=? AND state='queued'",
      )
      .get(owner, project)!.due,
    expired = db
      .query<{ due: number | null }, [string, string]>(
        "SELECT MIN(leaseUntil) due FROM knowledge_generation_jobs WHERE owner=? AND project=? AND state='claimed'",
      )
      .get(owner, project)!.due,
    times = [ready, expired].filter((value): value is number => value !== null),
    next = times.length ? Math.max(floor, Math.min(...times)) : null;
  db.query("UPDATE knowledge_generation_policies SET nextAdmissionAt=? WHERE owner=? AND project=?").run(
    next,
    owner,
    project,
  );
}

/** Policy replacement cannot cancel manual tasks or undo an already admitted file/Git save. */
export function cancelGeneratedTasks(
  db: Database,
  tasks: Pick<KnowledgeTaskStore, "cancel">,
  owner: string,
  project: string,
  now: number,
  source?: Pick<GenerationSourceIdentity, "id" | "kind">,
) {
  const rows = db
    .query<{ taskId: string }, (string | number)[]>(
      `SELECT g.taskId FROM knowledge_tasks t INDEXED BY knowledge_execution_owner
    CROSS JOIN knowledge_generation_origins g WHERE g.taskId=t.id AND t.owner=? AND t.project=?
    AND g.manual=0 AND t.state IN ('queued','running','waiting','review') ${source ? "AND g.documentId=? AND g.sourceKind=?" : ""}`,
    )
    .all(owner, project, ...(source ? [source.id, source.kind] : []));
  for (const { taskId } of rows) {
    tasks.cancel(owner, taskId, now);
    db.query(
      "UPDATE knowledge_reviews SET state='superseded',finishedAt=? WHERE taskId=? AND state IN ('running','passed')",
    ).run(now, taskId);
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
