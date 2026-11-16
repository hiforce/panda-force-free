import type { WorkflowResolution } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
/** Shared read model keeps recovery audit separate from transport receipts. */
export async function mysqlWorkflowResolutions(db: MySQLSession, job: string): Promise<WorkflowResolution[]> {
  return (
    await db.all<
      Omit<WorkflowResolution, "result"> & {
        result: string;
      }
    >(
      "SELECT r.stepId,r.evidenceId,r.actor,r.decidedAt,r.decision,e.result FROM panda_force_publication_resolutions r JOIN panda_force_publication_recovery_evidence e ON e.id=r.evidenceId WHERE e.jobId=? ORDER BY r.stepId",
      [job],
    )
  ).map((row) => ({ ...row, result: JSON.parse(row.result) }));
}
