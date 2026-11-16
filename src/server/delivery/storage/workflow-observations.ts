import type { Database } from "bun:sqlite";
import type { JsonValue, WorkflowObservation } from "../../../shared/delivery/workflow.js";
import type { PublicationLease, PublicationLeases } from "./leases.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";
import { workflowJson } from "./json.js";

/** Stores bounded status snapshots separately from irreversible operation receipts. */
export class WorkflowObservations {
  constructor(
    private db: Database,
    private leases: Pick<PublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  list(job: string): WorkflowObservation[] {
    return this.db
      .query<Omit<WorkflowObservation, "result"> & { result: string }, [string]>(
        "SELECT observationKey AS key,requestHash,result,observedAt FROM publication_observations WHERE jobId=? ORDER BY observationKey",
      )
      .all(job)
      .map((row) => ({ ...row, result: JSON.parse(row.result) }));
  }
  record(lease: PublicationLease, key: string, request: JsonValue, result: JsonValue) {
    if (!/^[a-z][a-z0-9.-]{0,99}$/.test(key)) throw new DeliveryError("invalidInput");
    const requestHash = digest(workflowJson(request, 8192)),
      payload = workflowJson(result, 32768);
    this.leases.guard(lease, () => {
      const existing = this.db
        .query<{ requestHash: string }, [string, string]>(
          "SELECT requestHash FROM publication_observations WHERE jobId=? AND observationKey=?",
        )
        .get(lease.id, key);
      if (existing && existing.requestHash !== requestHash) throw new DeliveryError("conflict", 409);
      if (!existing && this.list(lease.id).length >= 256) throw new DeliveryError("historyFull", 507);
      this.db
        .query(
          "INSERT INTO publication_observations VALUES(?,?,?,?,?) ON CONFLICT(jobId,observationKey) DO UPDATE SET result=excluded.result,observedAt=excluded.observedAt",
        )
        .run(lease.id, key, requestHash, payload, this.now());
    });
  }
}
