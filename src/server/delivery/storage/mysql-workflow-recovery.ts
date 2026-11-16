import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  WorkflowRecord,
  WorkflowRecoveryEvidence,
  WorkflowRecoveryReport,
} from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import { workflowJson } from "./json.js";
import { mysqlAssertWorkflowUnsealed } from "./mysql-workflow-lineage-read.js";
import { mysqlWorkflowResolutions } from "./mysql-workflow-resolutions.js";
/** Append-only evidence and explicit decisions are fenced against execution and stale lookups. */
export class MySQLWorkflowRecovery {
  constructor(
    private db: MySQLSession,
    private owned: (
      owner: string,
      id: string,
    ) => (WorkflowRecord | Promise<WorkflowRecord>) | Promise<Awaited<WorkflowRecord | Promise<WorkflowRecord>>>,
    private now = Date.now,
  ) {}
  async list(job: string): Promise<WorkflowRecoveryEvidence[]> {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<
          Omit<WorkflowRecoveryEvidence, "result" | "details"> & {
            result: string;
            details: string;
          }
        >(
          "SELECT id,stepId,actor,fingerprint,requestHash,stateToken,observedAt,expiresAt,status,result,details FROM panda_force_publication_recovery_evidence WHERE jobId=? ORDER BY rowSequence",
          [job],
        )
      ).map((row) => ({ ...row, result: JSON.parse(row.result), details: JSON.parse(row.details) }));
    });
  }
  async capture(owner: string, id: string, stepId: number) {
    return await this.db.atomic(async () => {
      if (!Number.isSafeInteger(stepId) || stepId <= 0) throw new DeliveryError("invalidInput");
      const record = await this.owned(owner, id);
      await mysqlAssertWorkflowUnsealed(this.db, id);
      const step = record.steps.find((item) => item.id === stepId),
        lease = (await this.db.one<{
          leaseFence: number;
          leaseUntil: number;
        }>("SELECT leaseFence,leaseUntil FROM panda_force_publication_jobs WHERE id=?", [id]))!;
      if (lease.leaseUntil > this.now() || ["queued", "waiting", "prepared", "completed"].includes(record.phase))
        throw new DeliveryError("recoveryBusy", 409);
      if (!step || step.outcome !== "pending" || record.resolutions.some((item) => item.stepId === stepId))
        throw new DeliveryError("conflict", 409);
      const { plan, phase, updatedAt, steps, cancellation, resolutions, confirmations } = record;
      const stateToken = digest(
        workflowJson(
          {
            plan,
            phase,
            updatedAt,
            steps,
            cancellation,
            resolutions,
            confirmations,
            lease,
          } as unknown as JsonValue,
          2 * 1024 * 1024,
        ),
      );
      return { record, step, stateToken };
    });
  }
  async record(
    owner: string,
    id: string,
    stepId: number,
    token: string,
    report: WorkflowRecoveryReport,
    authorize: () => void | Promise<Awaited<void>> = () => {},
  ) {
    return await this.db.atomic(async () => {
      const result = workflowJson(report.result, 32768),
        details = workflowJson(report.details, 32768);
      if (
        !["match", "mismatch", "unavailable"].includes(report.status) ||
        (report.status === "match" && report.result === null)
      )
        throw new DeliveryError("invalidInput");
      return await this.db.atomic(async () => {
        await authorize();
        const snapshot = await this.capture(owner, id, stepId);
        if (snapshot.stateToken !== token) throw new DeliveryError("recoveryChanged", 409);
        if ((await this.list(id)).length >= 100) throw new DeliveryError("historyFull", 507);
        const evidenceId = randomUUID();
        await this.db.execute(
          "INSERT INTO panda_force_publication_recovery_evidence(id,jobId,stepId,actor,fingerprint,requestHash,stateToken,observedAt,expiresAt,status,result,details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            evidenceId,
            id,
            stepId,
            owner,
            snapshot.record.plan.fingerprint,
            snapshot.step.requestHash,
            token,
            this.now(),
            this.now() + 600000,
            report.status,
            result,
            details,
          ],
        );
        return (await this.list(id)).find((item) => item.id === evidenceId)!;
      });
    });
  }
  async adopt(owner: string, id: string, evidenceId: string, authorize: () => void | Promise<Awaited<void>>) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.owned(owner, id);
        await authorize();
        const previous = (await mysqlWorkflowResolutions(this.db, id)).find((item) => item.evidenceId === evidenceId);
        if (previous) return previous;
        const evidence = (await this.list(id)).find((item) => item.id === evidenceId);
        if (!evidence || evidence.actor !== owner) throw new DeliveryError("notFound", 404);
        if (evidence.status !== "match") throw new DeliveryError("recoveryNotMatched", 409);
        if (evidence.expiresAt <= this.now()) throw new DeliveryError("recoveryExpired", 409);
        const snapshot = await this.capture(owner, id, evidence.stepId);
        if (
          snapshot.stateToken !== evidence.stateToken ||
          snapshot.step.requestHash !== evidence.requestHash ||
          snapshot.record.plan.fingerprint !== evidence.fingerprint
        )
          throw new DeliveryError("recoveryChanged", 409);
        await this.db.execute(
          "INSERT INTO panda_force_publication_resolutions(stepId,evidenceId,actor,decidedAt,decision) VALUES(?,?,?,?,'adopt-existing')",
          [evidence.stepId, evidence.id, owner, this.now()],
        );
        const resolved = new Set((await mysqlWorkflowResolutions(this.db, id)).map((item) => item.stepId)),
          pending = snapshot.record.steps.some((item) => item.outcome === "pending" && !resolved.has(item.id)),
          phase = pending ? "needsAttention" : snapshot.record.cancellation ? "cancelled" : "failed";
        // Resolution never queues another write. A fresh publication confirmation is still required.
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase=?,error=?,updatedAt=?,leaseFence=leaseFence+1,leaseUntil=0,nextRunAt=0 WHERE id=?",
          [phase, pending ? "outcomeUnknown" : null, this.now(), id],
        );
        return (await mysqlWorkflowResolutions(this.db, id)).find((item) => item.stepId === evidence.stepId)!;
      });
    });
  }
}
