import type { WorkflowStep } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
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
export async function mysqlReadWorkflowSteps(db: MySQLSession, job: string) {
  return (await db.all<StepRow>("SELECT * FROM panda_force_publication_steps WHERE jobId=? ORDER BY id", [job])).map(
    decodeWorkflowStep,
  );
}
