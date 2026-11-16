import { assertWorkflowUnsealed } from "./workflow-lineage-read.js";
import type { Database } from "bun:sqlite";
import type { WorkflowCancellation, WorkflowPhase } from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";

export function assertWorkflowContinuing(db: Database, id: string) {
  assertWorkflowUnsealed(db, id);
  if (db.query("SELECT jobId FROM publication_cancellations WHERE jobId=?").get(id))
    throw new DeliveryError("cancelled", 409);
}

/** A stop request does not revoke the current lease or erase an in-flight operation's receipt. */
export class WorkflowCancellations {
  constructor(
    private db: Database,
    private kind: string,
    private now = Date.now,
  ) {}
  get(id: string): WorkflowCancellation | null {
    return this.db
      .query<WorkflowCancellation, [string]>("SELECT actor,requestedAt FROM publication_cancellations WHERE jobId=?")
      .get(id);
  }
  assertContinuing(id: string) {
    assertWorkflowContinuing(this.db, id);
  }
  request(owner: string, id: string) {
    this.db
      .transaction(() => {
        const row = this.db
          .query<{ phase: WorkflowPhase }, [string, string, string]>(
            "SELECT j.phase FROM publication_jobs j JOIN publication_plans p ON p.id=j.id WHERE p.id=? AND p.ownerId=? AND p.kind=?",
          )
          .get(id, owner, this.kind);
        if (!row) throw new DeliveryError("notFound", 404);
        if (this.get(id) || row.phase === "cancelled") return;
        assertWorkflowUnsealed(this.db, id);
        if (row.phase === "completed") throw new DeliveryError("conflict", 409);
        this.db
          .query("INSERT INTO publication_cancellations(jobId,actor,requestedAt) VALUES(?,?,?)")
          .run(id, owner, this.now());
        if (row.phase === "running") {
          // The worker checks the request before its next effect; any current response may still settle.
          this.db.query("UPDATE publication_jobs SET updatedAt=? WHERE id=?").run(this.now(), id);
          return;
        }
        const pending = this.db
          .query(
            "SELECT s.id FROM publication_steps s LEFT JOIN publication_resolutions r ON r.stepId=s.id WHERE s.jobId=? AND s.outcome='pending' AND r.stepId IS NULL LIMIT 1",
          )
          .get(id);
        this.db
          .query("UPDATE publication_jobs SET phase=?,error=?,updatedAt=?,nextRunAt=0,leaseUntil=0 WHERE id=?")
          .run(pending ? "needsAttention" : "cancelled", pending ? "outcomeUnknown" : null, this.now(), id);
      })
      .immediate();
  }
}
