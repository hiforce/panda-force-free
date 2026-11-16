import type { ReadQueries } from "../../../shared/storage/read-queries.js";
import type { WorkflowStep } from "../../../shared/delivery/workflow.js";

export interface StepRow extends Omit<WorkflowStep, "key" | "result"> {
  stepKey: string;
  result: string | null;
  retryAllowed: number;
}
export const decodeWorkflowStep = (row: StepRow): WorkflowStep => ({
  id: row.id,
  key: row.stepKey,
  operation: row.operation,
  attempt: row.attempt,
  outcome: row.outcome,
  requestHash: row.requestHash,
  result: row.result ? JSON.parse(row.result) : null,
  error: row.error,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
  replacedBy: row.replacedBy,
});
export function readWorkflowSteps(db: ReadQueries, job: string) {
  return db
    .query<StepRow, [string]>("SELECT * FROM publication_steps WHERE jobId=? ORDER BY id")
    .all(job)
    .map(decodeWorkflowStep);
}
