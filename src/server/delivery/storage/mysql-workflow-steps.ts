import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import type { JsonValue, WorkflowStep } from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import { workflowJson } from "./json.js";
import type { MySQLPublicationLeases, PublicationLease } from "./mysql-leases.js";
import { mysqlAssertWorkflowContinuing } from "./mysql-workflow-cancellations.js";
import { mysqlAssertWorkflowUnsealed, mysqlReadWorkflowLineage } from "./mysql-workflow-lineage-read.js";
import { mysqlWorkflowResolutions } from "./mysql-workflow-resolutions.js";
import { decodeWorkflowStep as decode, mysqlReadWorkflowSteps, type StepRow } from "./mysql-workflow-step-read.js";
/** Stores irreversible operation attempts. A process restart never implies permission to repeat one. */
export class MySQLWorkflowSteps {
  constructor(
    private db: MySQLSession,
    private leases: Pick<MySQLPublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  async list(job: string) {
    return await this.db.atomic(async () => {
      return await mysqlReadWorkflowSteps(this.db, job);
    });
  }
  async effective(job: string) {
    return await this.db.atomic(async () => {
      return [
        ...(await mysqlReadWorkflowLineage(this.db, job)).steps,
        ...resolvedWorkflowSteps(await this.list(job), await mysqlWorkflowResolutions(this.db, job)),
      ];
    });
  }
  async intent(
    lease: PublicationLease,
    key: string,
    operation: string,
    input: JsonValue,
  ): Promise<{
    step: WorkflowStep;
    send: boolean;
  }> {
    return await this.db.atomic(async () => {
      if (!/^[a-z][a-z0-9.-]{0,99}$/.test(key) || !/^[a-z][a-z0-9.-]{0,63}$/.test(operation))
        throw new DeliveryError("invalidInput");
      const requestHash = digest(workflowJson(input, 1024 * 1024));
      return await this.leases.guard(lease, async () => {
        await mysqlAssertWorkflowContinuing(this.db, lease.id);
        const previous = await this.db.one<StepRow>(
          "SELECT * FROM panda_force_publication_steps WHERE jobId=? AND stepKey=? ORDER BY attempt DESC LIMIT 1",
          [lease.id, key],
        );
        if (!previous) {
          const inherited = (await mysqlReadWorkflowLineage(this.db, lease.id)).steps
            .filter((step) => step.key === key)
            .at(-1);
          if (inherited) {
            if (inherited.requestHash !== requestHash || inherited.operation !== operation)
              throw new DeliveryError("conflict", 409);
            return { step: inherited, send: false };
          }
        }
        if (previous) {
          if (previous.requestHash !== requestHash || previous.operation !== operation)
            throw new DeliveryError("conflict", 409);
          if (previous.outcome !== "rejected" || !previous.retryAllowed || previous.replacedBy !== null)
            return {
              step: resolvedWorkflowSteps([decode(previous)], await mysqlWorkflowResolutions(this.db, lease.id))[0]!,
              send: false,
            };
        }
        const count = (await this.db.one<{
          n: number;
        }>("SELECT count(*) AS n FROM panda_force_publication_steps", []))!.n;
        if (count >= 100000) throw new DeliveryError("historyFull", 507);
        const id = Number(
          (
            await this.db.execute(
              "INSERT INTO panda_force_publication_steps(jobId,stepKey,operation,attempt,outcome,requestHash,createdAt) VALUES(?,?,?,?,'pending',?,?)",
              [lease.id, key, operation, (previous?.attempt || 0) + 1, requestHash, this.now()],
            )
          ).lastInsertRowid,
        );
        if (previous)
          await this.db.execute("UPDATE panda_force_publication_steps SET retryAllowed=0 WHERE id=?", [previous.id]);
        return {
          step: decode((await this.db.one<StepRow>("SELECT * FROM panda_force_publication_steps WHERE id=?", [id]))!),
          send: true,
        };
      });
    });
  }
  async settle(
    lease: PublicationLease,
    id: number,
    outcome: "succeeded" | "rejected",
    result: JsonValue,
    error: string | null,
  ) {
    return await this.db.atomic(async () => {
      const payload = workflowJson(result, 128 * 1024);
      if (error && !/^[a-z][a-zA-Z0-9]{0,80}$/.test(error)) throw new DeliveryError("invalidInput");
      await this.leases.guard(lease, async () => {
        const changed = await this.db.execute(
          "UPDATE panda_force_publication_steps SET outcome=?,result=?,error=?,completedAt=? WHERE jobId=? AND id=? AND outcome='pending'",
          [outcome, payload, error, this.now(), lease.id, id],
        );
        if (changed.changes !== 1) throw new DeliveryError("conflict", 409);
      });
    });
  }
  /** Only an explicit resume may authorize another attempt after a definitive rejection. */
  async allowRetry(job: string) {
    return await this.db.atomic(async () => {
      await mysqlAssertWorkflowUnsealed(this.db, job);
      if ((await this.effective(job)).some((step) => step.outcome === "pending"))
        throw new DeliveryError("outcomeUnknown", 409);
      await this.db.execute(
        "UPDATE panda_force_publication_steps SET retryAllowed=1 WHERE jobId=? AND outcome='rejected' AND replacedBy IS NULL",
        [job],
      );
    });
  }
  /** Retain the original rejection and point to a confirmed replacement of the same operation. */
  async replaceRejected(lease: PublicationLease, rejectedKey: string, replacementKey: string) {
    return await this.db.atomic(async () => {
      await this.leases.guard(lease, async () => {
        if (
          !(
            await this.db.one<{
              resume: number;
            }>("SELECT resume FROM panda_force_publication_confirmations WHERE jobId=? ORDER BY id DESC LIMIT 1", [
              lease.id,
            ])
          )?.resume
        )
          throw new DeliveryError("publicationConfirmationRequired", 409);
        const latest = new Map((await this.effective(lease.id)).map((step) => [step.key, step]));
        const before = latest.get(rejectedKey),
          after = latest.get(replacementKey);
        if (
          !before ||
          !after ||
          before.outcome !== "rejected" ||
          after.outcome !== "succeeded" ||
          after.id <= before.id ||
          after.operation !== before.operation ||
          (before.replacedBy !== null && before.replacedBy !== after.id)
        )
          throw new DeliveryError("invalidReceipt", 409);
        await this.db.execute(
          "UPDATE panda_force_publication_steps SET replacedBy=?,retryAllowed=0 WHERE id=? AND jobId=?",
          [after.id, before.id, lease.id],
        );
      });
    });
  }
}
