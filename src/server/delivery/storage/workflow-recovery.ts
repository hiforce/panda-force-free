import { assertWorkflowUnsealed } from "./workflow-lineage-read.js";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  WorkflowRecord,
  JsonValue,
  WorkflowRecoveryEvidence,
  WorkflowRecoveryReport,
} from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";
import { workflowJson } from "./json.js";
import { workflowResolutions } from "./workflow-resolutions.js";

/** Append-only evidence and explicit decisions are fenced against execution and stale lookups. */
export class WorkflowRecovery {
  constructor(
    private db: Database,
    private owned: (owner: string, id: string) => WorkflowRecord,
    private now = Date.now,
  ) {}
  list(job: string): WorkflowRecoveryEvidence[] {
    return this.db
      .query<Omit<WorkflowRecoveryEvidence, "result" | "details"> & { result: string; details: string }, [string]>(
        "SELECT id,stepId,actor,fingerprint,requestHash,stateToken,observedAt,expiresAt,status,result,details FROM publication_recovery_evidence WHERE jobId=? ORDER BY rowid",
      )
      .all(job)
      .map((row) => ({ ...row, result: JSON.parse(row.result), details: JSON.parse(row.details) }));
  }
  capture(owner: string, id: string, stepId: number) {
    if (!Number.isSafeInteger(stepId) || stepId <= 0) throw new DeliveryError("invalidInput");
    const record = this.owned(owner, id);
    assertWorkflowUnsealed(this.db, id);
    const step = record.steps.find((item) => item.id === stepId),
      lease = this.db
        .query<{ leaseFence: number; leaseUntil: number }, [string]>(
          "SELECT leaseFence,leaseUntil FROM publication_jobs WHERE id=?",
        )
        .get(id)!;
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
  }
  record(
    owner: string,
    id: string,
    stepId: number,
    token: string,
    report: WorkflowRecoveryReport,
    authorize: () => void = () => {},
  ) {
    const result = workflowJson(report.result, 32768),
      details = workflowJson(report.details, 32768);
    if (
      !["match", "mismatch", "unavailable"].includes(report.status) ||
      (report.status === "match" && report.result === null)
    )
      throw new DeliveryError("invalidInput");
    return this.db
      .transaction(() => {
        authorize();
        const snapshot = this.capture(owner, id, stepId);
        if (snapshot.stateToken !== token) throw new DeliveryError("recoveryChanged", 409);
        if (this.list(id).length >= 100) throw new DeliveryError("historyFull", 507);
        const evidenceId = randomUUID();
        this.db
          .query(
            "INSERT INTO publication_recovery_evidence(id,jobId,stepId,actor,fingerprint,requestHash,stateToken,observedAt,expiresAt,status,result,details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
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
          );
        return this.list(id).find((item) => item.id === evidenceId)!;
      })
      .immediate();
  }
  adopt(owner: string, id: string, evidenceId: string, authorize: () => void) {
    return this.db
      .transaction(() => {
        this.owned(owner, id);
        authorize();
        const previous = workflowResolutions(this.db, id).find((item) => item.evidenceId === evidenceId);
        if (previous) return previous;
        const evidence = this.list(id).find((item) => item.id === evidenceId);
        if (!evidence || evidence.actor !== owner) throw new DeliveryError("notFound", 404);
        if (evidence.status !== "match") throw new DeliveryError("recoveryNotMatched", 409);
        if (evidence.expiresAt <= this.now()) throw new DeliveryError("recoveryExpired", 409);
        const snapshot = this.capture(owner, id, evidence.stepId);
        if (
          snapshot.stateToken !== evidence.stateToken ||
          snapshot.step.requestHash !== evidence.requestHash ||
          snapshot.record.plan.fingerprint !== evidence.fingerprint
        )
          throw new DeliveryError("recoveryChanged", 409);
        this.db
          .query(
            "INSERT INTO publication_resolutions(stepId,evidenceId,actor,decidedAt,decision) VALUES(?,?,?,?,'adopt-existing')",
          )
          .run(evidence.stepId, evidence.id, owner, this.now());
        const resolved = new Set(workflowResolutions(this.db, id).map((item) => item.stepId)),
          pending = snapshot.record.steps.some((item) => item.outcome === "pending" && !resolved.has(item.id)),
          phase = pending ? "needsAttention" : snapshot.record.cancellation ? "cancelled" : "failed";
        // Resolution never queues another write. A fresh publication confirmation is still required.
        this.db
          .query(
            "UPDATE publication_jobs SET phase=?,error=?,updatedAt=?,leaseFence=leaseFence+1,leaseUntil=0,nextRunAt=0 WHERE id=?",
          )
          .run(phase, pending ? "outcomeUnknown" : null, this.now(), id);
        return workflowResolutions(this.db, id).find((item) => item.stepId === evidence.stepId)!;
      })
      .immediate();
  }
}
