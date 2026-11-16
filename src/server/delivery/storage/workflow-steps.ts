import type { Database } from "bun:sqlite";
import type { JsonValue, WorkflowStep } from "../../../shared/delivery/workflow.js";
import type { PublicationLease, PublicationLeases } from "./leases.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";
import { resolvedWorkflowSteps } from "../../../shared/delivery/recovery.js";
import { workflowResolutions } from "./workflow-resolutions.js";
import { workflowJson } from "./json.js";
import { readWorkflowSteps, decodeWorkflowStep as decode, type StepRow } from "./workflow-step-read.js";
import { readWorkflowLineage, assertWorkflowUnsealed } from "./workflow-lineage-read.js";
import { assertWorkflowContinuing } from "./workflow-cancellations.js";

/** Stores irreversible operation attempts. A process restart never implies permission to repeat one. */
export class WorkflowSteps {
  constructor(
    private db: Database,
    private leases: Pick<PublicationLeases, "guard">,
    private now = Date.now,
  ) {}
  list(job: string) {
    return readWorkflowSteps(this.db, job);
  }
  effective(job: string) {
    return [
      ...readWorkflowLineage(this.db, job).steps,
      ...resolvedWorkflowSteps(this.list(job), workflowResolutions(this.db, job)),
    ];
  }
  intent(
    lease: PublicationLease,
    key: string,
    operation: string,
    input: JsonValue,
  ): { step: WorkflowStep; send: boolean } {
    if (!/^[a-z][a-z0-9.-]{0,99}$/.test(key) || !/^[a-z][a-z0-9.-]{0,63}$/.test(operation))
      throw new DeliveryError("invalidInput");
    const requestHash = digest(workflowJson(input, 1024 * 1024));
    return this.leases.guard(lease, () => {
      assertWorkflowContinuing(this.db, lease.id);
      const previous = this.db
        .query<StepRow, [string, string]>(
          "SELECT * FROM publication_steps WHERE jobId=? AND stepKey=? ORDER BY attempt DESC LIMIT 1",
        )
        .get(lease.id, key);
      if (!previous) {
        const inherited = readWorkflowLineage(this.db, lease.id)
          .steps.filter((step) => step.key === key)
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
            step: resolvedWorkflowSteps([decode(previous)], workflowResolutions(this.db, lease.id))[0]!,
            send: false,
          };
      }
      const count = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM publication_steps").get()!.n;
      if (count >= 100000) throw new DeliveryError("historyFull", 507);
      const id = Number(
        this.db
          .query(
            "INSERT INTO publication_steps(jobId,stepKey,operation,attempt,outcome,requestHash,createdAt) VALUES(?,?,?,?,'pending',?,?)",
          )
          .run(lease.id, key, operation, (previous?.attempt || 0) + 1, requestHash, this.now()).lastInsertRowid,
      );
      if (previous) this.db.query("UPDATE publication_steps SET retryAllowed=0 WHERE id=?").run(previous.id);
      return {
        step: decode(this.db.query<StepRow, [number]>("SELECT * FROM publication_steps WHERE id=?").get(id)!),
        send: true,
      };
    });
  }
  settle(
    lease: PublicationLease,
    id: number,
    outcome: "succeeded" | "rejected",
    result: JsonValue,
    error: string | null,
  ) {
    const payload = workflowJson(result, 128 * 1024);
    if (error && !/^[a-z][a-zA-Z0-9]{0,80}$/.test(error)) throw new DeliveryError("invalidInput");
    this.leases.guard(lease, () => {
      const changed = this.db
        .query(
          "UPDATE publication_steps SET outcome=?,result=?,error=?,completedAt=? WHERE jobId=? AND id=? AND outcome='pending'",
        )
        .run(outcome, payload, error, this.now(), lease.id, id);
      if (changed.changes !== 1) throw new DeliveryError("conflict", 409);
    });
  }
  /** Only an explicit resume may authorize another attempt after a definitive rejection. */
  allowRetry(job: string) {
    assertWorkflowUnsealed(this.db, job);
    if (this.effective(job).some((step) => step.outcome === "pending")) throw new DeliveryError("outcomeUnknown", 409);
    this.db
      .query("UPDATE publication_steps SET retryAllowed=1 WHERE jobId=? AND outcome='rejected' AND replacedBy IS NULL")
      .run(job);
  }
  /** Retain the original rejection and point to a confirmed replacement of the same operation. */
  replaceRejected(lease: PublicationLease, rejectedKey: string, replacementKey: string) {
    this.leases.guard(lease, () => {
      if (
        !this.db
          .query<{ resume: number }, [string]>(
            "SELECT resume FROM publication_confirmations WHERE jobId=? ORDER BY id DESC LIMIT 1",
          )
          .get(lease.id)?.resume
      )
        throw new DeliveryError("publicationConfirmationRequired", 409);
      const latest = new Map(this.effective(lease.id).map((step) => [step.key, step]));
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
      this.db
        .query("UPDATE publication_steps SET replacedBy=?,retryAllowed=0 WHERE id=? AND jobId=?")
        .run(after.id, before.id, lease.id);
    });
  }
}
