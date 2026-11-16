import type { ReadQueries } from "../../../shared/storage/read-queries.js";
import type { WorkflowResolution } from "../../../shared/delivery/workflow.js";

/** Shared read model keeps recovery audit separate from transport receipts. */
export function workflowResolutions(db: ReadQueries, job: string): WorkflowResolution[] {
  return db
    .query<Omit<WorkflowResolution, "result"> & { result: string }, [string]>(
      "SELECT r.stepId,r.evidenceId,r.actor,r.decidedAt,r.decision,e.result FROM publication_resolutions r JOIN publication_recovery_evidence e ON e.id=r.evidenceId WHERE e.jobId=? ORDER BY r.stepId",
    )
    .all(job)
    .map((row) => ({ ...row, result: JSON.parse(row.result) }));
}
