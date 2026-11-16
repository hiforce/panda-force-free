import type { Database } from "bun:sqlite";
import type {
  WorkflowPlan,
  WorkflowRecord,
  WorkflowPhase,
  WorkflowConfirmation,
  JsonValue,
} from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../digest.js";
import { initializePublicationSchema } from "./schema.js";
import { PublicationLeases, type PublicationLease } from "./leases.js";
import { WorkflowSteps } from "./workflow-steps.js";
import { WorkflowObservations } from "./workflow-observations.js";
import { WorkflowCancellations } from "./workflow-cancellations.js";
import { WorkflowRecovery } from "./workflow-recovery.js";
import { workflowResolutions } from "./workflow-resolutions.js";
import { readWorkflowPlan, workflowPlanInput } from "./workflow-plan-read.js";
import { readWorkflowLineage } from "./workflow-lineage-read.js";
import { WorkflowLineageRepository } from "./workflow-lineage.js";
import { workflowJson } from "./json.js";

interface Row {
  ownerId: string;
  record: string;
  request: string;
  phase: WorkflowPhase;
  error: string | null;
  updatedAt: number;
  receipt: string | null;
  nextRunAt: number;
  sourceProjectId: string | null;
}
/** Typed workflow facades own payload validation. This store owns durable state, identity and execution leases. */
export class WorkflowRepository {
  readonly leases: PublicationLeases;
  readonly steps: WorkflowSteps;
  readonly observations: WorkflowObservations;
  readonly lineage: WorkflowLineageRepository;
  readonly recovery: WorkflowRecovery;
  readonly cancellations: WorkflowCancellations;
  constructor(
    private db: Database,
    readonly kind: string,
    private now = Date.now,
  ) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(kind) || kind === "site") throw new DeliveryError("invalidInput");
    initializePublicationSchema(db);
    this.leases = new PublicationLeases(db, now, kind);
    this.steps = new WorkflowSteps(db, this.leases, now);
    this.observations = new WorkflowObservations(db, this.leases, now);
    this.lineage = new WorkflowLineageRepository(
      db,
      (owner, id) => this.owned(owner, id),
      (owner, identity, input) => this.prepare(owner, identity, input),
      now,
    );
    this.recovery = new WorkflowRecovery(db, (owner, id) => this.owned(owner, id), now);
    this.cancellations = new WorkflowCancellations(db, kind, now);
  }
  private row(id: string) {
    const value = this.db
      .query<Row, [string, string]>(
        "SELECT p.ownerId,p.record,p.request,p.sourceProjectId,j.phase,j.error,j.updatedAt,j.receipt,j.nextRunAt FROM publication_plans p JOIN publication_jobs j ON j.id=p.id WHERE p.kind=? AND p.id=?",
      )
      .get(this.kind, id);
    if (!value) throw new DeliveryError("notFound", 404);
    return value;
  }
  get(id: string): WorkflowRecord {
    const row = this.row(id);
    const plan = readWorkflowPlan(row.record, row.request, id, this.kind);
    if ((plan.sourceProjectId ?? null) !== row.sourceProjectId) throw new DeliveryError("invalidSnapshot", 409);
    const record: Omit<WorkflowRecord, "continuationToken"> = {
      plan,
      phase: row.phase,
      error: row.error,
      updatedAt: row.updatedAt,
      receipt: row.receipt ? JSON.parse(row.receipt) : null,
      steps: this.steps.list(id),
      observations: this.observations.list(id),
      nextRunAt: row.phase === "waiting" ? row.nextRunAt : null,
      cancellation: this.cancellations.get(id),
      recoveryEvidence: this.recovery.list(id),
      resolutions: workflowResolutions(this.db, id),
      lineage: readWorkflowLineage(this.db, id),
      confirmations: this.db
        .query<Omit<WorkflowConfirmation, "details" | "resume"> & { details: string; resume: number }, [string]>(
          "SELECT actor,fingerprint,createdAt,resume,details FROM publication_confirmations WHERE jobId=? ORDER BY id",
        )
        .all(id)
        .map((row) => ({ ...row, resume: Boolean(row.resume), details: JSON.parse(row.details) })),
    };
    const { phase, updatedAt, steps, resolutions, confirmations, cancellation, lineage } = record;
    const continuationToken = digest(
      workflowJson(
        {
          fingerprint: plan.fingerprint,
          phase,
          updatedAt,
          steps,
          resolutions,
          confirmationCount: confirmations.length,
          cancellation,
          lineage,
        } as unknown as JsonValue,
        2 * 1024 * 1024,
      ),
    );
    return { ...record, continuationToken };
  }
  owned(owner: string, id: string) {
    if (this.row(id).ownerId !== owner) throw new DeliveryError("notFound", 404);
    return this.get(id);
  }
  owner(id: string) {
    return this.row(id).ownerId;
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  list(owner: string, space: string, sourceProjectId?: string) {
    return this.db
      .query<{ id: string }, [string, string, string, string | null]>(
        "SELECT id FROM publication_plans WHERE kind=? AND ownerId=? AND spaceId=? AND sourceProjectId IS ? ORDER BY rowid DESC LIMIT 50",
      )
      .all(this.kind, owner, space, sourceProjectId ?? null)
      .map((row) => this.get(row.id));
  }
  prepare(
    owner: string,
    identity: string,
    input: Omit<WorkflowPlan, "kind" | "fingerprint" | "createdAt" | "expiresAt">,
  ) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new DeliveryError("invalidInput");
    if (
      input.sourceProjectId !== undefined &&
      (input.sourceProjectId !== input.projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.sourceProjectId))
    )
      throw new DeliveryError("invalidInput");
    if (
      [owner, input.id, input.projectId, input.spaceId, input.connectionId].some(
        (part) => typeof part !== "string" || !part || part.length > 200 || /\p{Cc}/u.test(part),
      )
    )
      throw new DeliveryError("invalidInput");
    const content = workflowJson(input, 1024 * 1024),
      fingerprint = digest(content);
    return this.db
      .transaction(() => {
        const byId = this.db
          .query<{ id: string; request: string }, [string]>("SELECT id,request FROM publication_plans WHERE id=?")
          .get(input.id);
        if (byId) {
          const previous = this.owned(owner, byId.id);
          if (byId.request !== fingerprint) throw new DeliveryError("conflict", 409);
          return previous;
        }
        const existing = this.db
          .query<{ id: string }, [string, string, string]>(
            "SELECT id FROM publication_plans WHERE kind=? AND ownerId=? AND identity=?",
          )
          .get(this.kind, owner, identity);
        if (existing) {
          const previous = this.owned(owner, existing.id);
          const previousInput = workflowPlanInput(previous.plan);
          if (digest(workflowJson({ ...previousInput, id: input.id }, 1024 * 1024)) !== fingerprint)
            throw new DeliveryError("conflict", 409);
          return previous;
        }
        const count = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM publication_plans").get()!.n;
        if (count >= 1000) throw new DeliveryError("historyFull", 507);
        const plan: WorkflowPlan = {
          ...input,
          kind: this.kind,
          fingerprint,
          createdAt: this.now(),
          expiresAt: this.now() + 86400000,
        };
        this.db
          .query(
            "INSERT INTO publication_plans(id,ownerId,spaceId,connectionId,record,request,artifactHash,kind,identity,sourceProjectId) VALUES(?,?,?,?,?,?,NULL,?,?,?)",
          )
          .run(
            plan.id,
            owner,
            plan.spaceId,
            plan.connectionId,
            JSON.stringify(plan),
            fingerprint,
            this.kind,
            identity,
            plan.sourceProjectId ?? null,
          );
        this.db
          .query("INSERT INTO publication_jobs(id,phase,updatedAt) VALUES(?,'prepared',?)")
          .run(plan.id, this.now());
        return this.get(plan.id);
      })
      .immediate();
  }
  /** Preflight is repeated inside the queue transaction after asynchronous source authorization. */
  queueState(owner: string, id: string, fingerprint: string, resume = false) {
    const record = this.owned(owner, id);
    if (record.plan.fingerprint !== fingerprint) throw new DeliveryError("conflict", 409);
    this.cancellations.assertContinuing(id);
    if (["queued", "running", "waiting", "completed"].includes(record.phase)) return { record, ready: false };
    if (record.phase !== "prepared" && !(resume && record.phase === "failed")) throw new DeliveryError("conflict", 409);
    if (record.plan.expiresAt <= this.now()) throw new DeliveryError("planExpired", 409);
    return { record, ready: true };
  }
  queue(
    owner: string,
    id: string,
    fingerprint: string,
    authorize: (plan: WorkflowPlan) => void,
    resume = false,
    confirmation: JsonValue = null,
  ) {
    const details = workflowJson(confirmation, 8192);
    return this.db
      .transaction(() => {
        const { record, ready } = this.queueState(owner, id, fingerprint, resume);
        if (!ready) return record;
        authorize(record.plan);
        if (resume) this.steps.allowRetry(id);
        this.db
          .query(
            "INSERT INTO publication_confirmations(jobId,actor,fingerprint,createdAt,resume,details) VALUES(?,?,?,?,?,?)",
          )
          .run(id, owner, fingerprint, this.now(), Number(resume), details);
        this.db
          .query("UPDATE publication_jobs SET phase='queued',error=NULL,updatedAt=? WHERE id=?")
          .run(this.now(), id);
        return this.get(id);
      })
      .immediate();
  }
  finish(
    lease: PublicationLease,
    phase: "completed" | "failed" | "needsAttention" | "cancelled",
    receipt: JsonValue,
    error: string | null,
  ) {
    const payload = workflowJson(receipt, 128 * 1024);
    if (error && !/^[a-z][a-zA-Z0-9]{0,80}$/.test(error)) throw new DeliveryError("invalidInput");
    return this.leases.guard(lease, () => {
      const steps = this.steps.effective(lease.id),
        latest = new Map(steps.map((step) => [step.key, step]));
      const cancellation = this.cancellations.get(lease.id);
      if (cancellation && phase !== "completed") {
        phase = steps.some((step) => step.outcome === "pending") ? "needsAttention" : "cancelled";
        error = phase === "cancelled" ? null : !error || error === "cancelled" ? "outcomeUnknown" : error;
      }
      if (phase === "cancelled" && !cancellation) throw new DeliveryError("conflict", 409);
      const settled = (step: (typeof steps)[number]) =>
        step.outcome === "succeeded" ||
        (step.outcome === "rejected" &&
          step.replacedBy !== null &&
          steps.some(
            (replacement) =>
              replacement.id === step.replacedBy &&
              replacement.id > step.id &&
              replacement.operation === step.operation &&
              replacement.outcome === "succeeded",
          ));
      if (phase === "completed" && [...latest.values()].some((step) => !settled(step)))
        throw new DeliveryError("outcomeUnknown", 409);
      this.db
        .query("UPDATE publication_jobs SET phase=?,receipt=?,error=?,updatedAt=?,leaseUntil=0 WHERE id=?")
        .run(phase, payload, error, this.now(), lease.id);
      return this.get(lease.id);
    });
  }
  wait(lease: PublicationLease, until: number) {
    return this.leases.guard(lease, () => {
      this.cancellations.assertContinuing(lease.id);
      if (!Number.isSafeInteger(until) || until <= this.now() || until > this.now() + 3600000)
        throw new DeliveryError("invalidInput");
      if (this.steps.effective(lease.id).some((step) => step.outcome === "pending"))
        throw new DeliveryError("outcomeUnknown", 409);
      if (until >= this.get(lease.id).plan.expiresAt) throw new DeliveryError("planExpired", 409);
      this.db
        .query("UPDATE publication_jobs SET phase='waiting',nextRunAt=?,error=NULL,updatedAt=?,leaseUntil=0 WHERE id=?")
        .run(until, this.now(), lease.id);
      return this.get(lease.id);
    });
  }
  cancel(owner: string, id: string) {
    this.cancellations.request(owner, id);
    return this.owned(owner, id);
  }
}
