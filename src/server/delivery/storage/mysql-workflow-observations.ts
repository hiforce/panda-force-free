import type { JsonValue, WorkflowObservation } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import { workflowJson } from "./json.js";
import type { MySQLPublicationLeases, PublicationLease } from "./mysql-leases.js";
/** Stores bounded status snapshots separately from irreversible operation receipts. */
export class MySQLWorkflowObservations {
  constructor(
    private db: MySQLSession,
    private leases: Pick<MySQLPublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  async list(job: string): Promise<WorkflowObservation[]> {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<
          Omit<WorkflowObservation, "result"> & {
            result: string;
          }
        >(
          "SELECT observationKey AS `key`,requestHash,result,observedAt FROM panda_force_publication_observations WHERE jobId=? ORDER BY observationKey",
          [job],
        )
      ).map((row) => ({ ...row, result: JSON.parse(row.result) }));
    });
  }
  async record(lease: PublicationLease, key: string, request: JsonValue, result: JsonValue) {
    return await this.db.atomic(async () => {
      if (!/^[a-z][a-z0-9.-]{0,99}$/.test(key)) throw new DeliveryError("invalidInput");
      const requestHash = digest(workflowJson(request, 8192)),
        payload = workflowJson(result, 32768);
      await this.leases.guard(lease, async () => {
        const existing = await this.db.one<{
          requestHash: string;
        }>("SELECT requestHash FROM panda_force_publication_observations WHERE jobId=? AND observationKey=?", [
          lease.id,
          key,
        ]);
        if (existing && existing.requestHash !== requestHash) throw new DeliveryError("conflict", 409);
        if (!existing && (await this.list(lease.id)).length >= 256) throw new DeliveryError("historyFull", 507);
        await this.db.execute(
          "INSERT INTO panda_force_publication_observations(jobId,observationKey,requestHash,result,observedAt) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE result=VALUES(result),observedAt=VALUES(observedAt)",
          [lease.id, key, requestHash, payload, this.now()],
        );
      });
    });
  }
}
