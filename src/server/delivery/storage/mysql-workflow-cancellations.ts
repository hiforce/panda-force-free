import type { WorkflowCancellation, WorkflowPhase } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { DeliveryError } from "../errors.js";
import { mysqlAssertWorkflowUnsealed } from "./mysql-workflow-lineage-read.js";
export async function mysqlAssertWorkflowContinuing(db: MySQLSession, id: string) {
  await mysqlAssertWorkflowUnsealed(db, id);
  if (await db.one("SELECT jobId FROM panda_force_publication_cancellations WHERE jobId=?", [id]))
    throw new DeliveryError("cancelled", 409);
}
/** A stop request does not revoke the current lease or erase an in-flight operation's receipt. */
export class MySQLWorkflowCancellations {
  constructor(
    private db: MySQLSession,
    private kind: string,
    private now = Date.now,
  ) {}
  async get(id: string): Promise<WorkflowCancellation | null> {
    return await this.db.atomic(async () => {
      return await this.db.one<WorkflowCancellation>(
        "SELECT actor,requestedAt FROM panda_force_publication_cancellations WHERE jobId=?",
        [id],
      );
    });
  }
  async assertContinuing(id: string) {
    return await this.db.atomic(async () => {
      await mysqlAssertWorkflowContinuing(this.db, id);
    });
  }
  async request(owner: string, id: string) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const row = await this.db.one<{
          phase: WorkflowPhase;
        }>(
          "SELECT j.phase FROM panda_force_publication_jobs j JOIN panda_force_publication_plans p ON p.id=j.id WHERE p.id=? AND p.ownerId=? AND p.kind=?",
          [id, owner, this.kind],
        );
        if (!row) throw new DeliveryError("notFound", 404);
        if ((await this.get(id)) || row.phase === "cancelled") return;
        await mysqlAssertWorkflowUnsealed(this.db, id);
        if (row.phase === "completed") throw new DeliveryError("conflict", 409);
        await this.db.execute(
          "INSERT INTO panda_force_publication_cancellations(jobId,actor,requestedAt) VALUES(?,?,?)",
          [id, owner, this.now()],
        );
        if (row.phase === "running") {
          // The worker checks the request before its next effect; any current response may still settle.
          await this.db.execute("UPDATE panda_force_publication_jobs SET updatedAt=? WHERE id=?", [this.now(), id]);
          return;
        }
        const pending = await this.db.one(
          "SELECT s.id FROM panda_force_publication_steps s LEFT JOIN panda_force_publication_resolutions r ON r.stepId=s.id WHERE s.jobId=? AND s.outcome='pending' AND r.stepId IS NULL LIMIT 1",
          [id],
        );
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase=?,error=?,updatedAt=?,nextRunAt=0,leaseUntil=0 WHERE id=?",
          [pending ? "needsAttention" : "cancelled", pending ? "outcomeUnknown" : null, this.now(), id],
        );
      });
    });
  }
}
