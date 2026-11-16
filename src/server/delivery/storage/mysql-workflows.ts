import type {
  JsonValue,
  WorkflowConfirmation,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRecord,
} from "../../../shared/delivery/workflow.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { digest } from "../digest.js";
import { DeliveryError } from "../errors.js";
import { workflowJson } from "./json.js";
import { MySQLPublicationLeases, type PublicationLease } from "./mysql-leases.js";
import { MySQLWorkflowCancellations } from "./mysql-workflow-cancellations.js";
import { mysqlReadWorkflowLineage } from "./mysql-workflow-lineage-read.js";
import { MySQLWorkflowLineageRepository } from "./mysql-workflow-lineage.js";
import { MySQLWorkflowObservations } from "./mysql-workflow-observations.js";
import { MySQLWorkflowRecovery } from "./mysql-workflow-recovery.js";
import { mysqlWorkflowResolutions } from "./mysql-workflow-resolutions.js";
import { MySQLWorkflowSteps } from "./mysql-workflow-steps.js";
import { readWorkflowPlan, workflowPlanInput } from "./workflow-plan-read.js";
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
export class MySQLWorkflowRepository {
  readonly leases: MySQLPublicationLeases;
  readonly steps: MySQLWorkflowSteps;
  readonly observations: MySQLWorkflowObservations;
  readonly lineage: MySQLWorkflowLineageRepository;
  readonly recovery: MySQLWorkflowRecovery;
  readonly cancellations: MySQLWorkflowCancellations;
  constructor(
    private db: MySQLSession,
    readonly kind: string,
    private now = Date.now,
  ) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(kind) || kind === "site") throw new DeliveryError("invalidInput");
    this.leases = new MySQLPublicationLeases(db, now, kind);
    this.steps = new MySQLWorkflowSteps(db, this.leases, now);
    this.observations = new MySQLWorkflowObservations(db, this.leases, now);
    this.lineage = new MySQLWorkflowLineageRepository(
      db,
      async (owner, id) => await this.owned(owner, id),
      async (owner, identity, input) => await this.prepare(owner, identity, input),
      now,
    );
    this.recovery = new MySQLWorkflowRecovery(db, async (owner, id) => await this.owned(owner, id), now);
    this.cancellations = new MySQLWorkflowCancellations(db, kind, now);
  }
  private async row(id: string) {
    return await this.db.atomic(async () => {
      const value = await this.db.one<Row>(
        "SELECT p.ownerId,p.record,p.request,p.sourceProjectId,j.phase,j.error,j.updatedAt,j.receipt,j.nextRunAt FROM panda_force_publication_plans p JOIN panda_force_publication_jobs j ON j.id=p.id WHERE p.kind=? AND p.id=?",
        [this.kind, id],
      );
      if (!value) throw new DeliveryError("notFound", 404);
      return value;
    });
  }
  async get(id: string): Promise<WorkflowRecord> {
    return await this.db.atomic(async () => {
      const row = await this.row(id);
      const plan = readWorkflowPlan(row.record, row.request, id, this.kind);
      if ((plan.sourceProjectId ?? null) !== row.sourceProjectId) throw new DeliveryError("invalidSnapshot", 409);
      const record: Omit<WorkflowRecord, "continuationToken"> = {
        plan,
        phase: row.phase,
        error: row.error,
        updatedAt: row.updatedAt,
        receipt: row.receipt ? JSON.parse(row.receipt) : null,
        steps: await this.steps.list(id),
        observations: await this.observations.list(id),
        nextRunAt: row.phase === "waiting" ? row.nextRunAt : null,
        cancellation: await this.cancellations.get(id),
        recoveryEvidence: await this.recovery.list(id),
        resolutions: await mysqlWorkflowResolutions(this.db, id),
        lineage: await mysqlReadWorkflowLineage(this.db, id),
        confirmations: (
          await this.db.all<
            Omit<WorkflowConfirmation, "details" | "resume"> & {
              details: string;
              resume: number;
            }
          >(
            "SELECT actor,fingerprint,createdAt,resume,details FROM panda_force_publication_confirmations WHERE jobId=? ORDER BY id",
            [id],
          )
        ).map((row) => ({ ...row, resume: Boolean(row.resume), details: JSON.parse(row.details) })),
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
    });
  }
  async owned(owner: string, id: string) {
    return await this.db.atomic(async () => {
      if ((await this.row(id)).ownerId !== owner) throw new DeliveryError("notFound", 404);
      return await this.get(id);
    });
  }
  async owner(id: string) {
    return await this.db.atomic(async () => {
      return (await this.row(id)).ownerId;
    });
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => await work());
    });
  }
  async list(owner: string, space: string, sourceProjectId?: string) {
    return await this.db.atomic(async () => {
      return await Promise.all(
        (
          await this.db.all<{
            id: string;
          }>(
            "SELECT id FROM panda_force_publication_plans WHERE kind=? AND ownerId=? AND spaceId=? AND sourceProjectId <=> ? ORDER BY rowSequence DESC LIMIT 50",
            [this.kind, owner, space, sourceProjectId ?? null],
          )
        ).map(async (row) => await this.get(row.id)),
      );
    });
  }
  async prepare(
    owner: string,
    identity: string,
    input: Omit<WorkflowPlan, "kind" | "fingerprint" | "createdAt" | "expiresAt">,
  ) {
    return await this.db.atomic(async () => {
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
      return await this.db.atomic(async () => {
        const byId = await this.db.one<{
          id: string;
          request: string;
        }>("SELECT id,request FROM panda_force_publication_plans WHERE id=?", [input.id]);
        if (byId) {
          const previous = await this.owned(owner, byId.id);
          if (byId.request !== fingerprint) throw new DeliveryError("conflict", 409);
          return previous;
        }
        const existing = await this.db.one<{
          id: string;
        }>("SELECT id FROM panda_force_publication_plans WHERE kind=? AND ownerId=? AND identity=?", [
          this.kind,
          owner,
          identity,
        ]);
        if (existing) {
          const previous = await this.owned(owner, existing.id);
          const previousInput = workflowPlanInput(previous.plan);
          if (digest(workflowJson({ ...previousInput, id: input.id }, 1024 * 1024)) !== fingerprint)
            throw new DeliveryError("conflict", 409);
          return previous;
        }
        const count = (await this.db.one<{
          n: number;
        }>("SELECT count(*) AS n FROM panda_force_publication_plans", []))!.n;
        if (count >= 1000) throw new DeliveryError("historyFull", 507);
        const plan: WorkflowPlan = {
          ...input,
          kind: this.kind,
          fingerprint,
          createdAt: this.now(),
          expiresAt: this.now() + 86400000,
        };
        await this.db.execute(
          "INSERT INTO panda_force_publication_plans(id,ownerId,spaceId,connectionId,record,request,artifactHash,kind,identity,sourceProjectId) VALUES(?,?,?,?,?,?,NULL,?,?,?)",
          [
            plan.id,
            owner,
            plan.spaceId,
            plan.connectionId,
            JSON.stringify(plan),
            fingerprint,
            this.kind,
            identity,
            plan.sourceProjectId ?? null,
          ],
        );
        await this.db.execute("INSERT INTO panda_force_publication_jobs(id,phase,updatedAt) VALUES(?,'prepared',?)", [
          plan.id,
          this.now(),
        ]);
        return await this.get(plan.id);
      });
    });
  }
  /** Preflight is repeated inside the queue transaction after asynchronous source authorization. */
  async queueState(owner: string, id: string, fingerprint: string, resume = false) {
    return await this.db.atomic(async () => {
      const record = await this.owned(owner, id);
      if (record.plan.fingerprint !== fingerprint) throw new DeliveryError("conflict", 409);
      await this.cancellations.assertContinuing(id);
      if (["queued", "running", "waiting", "completed"].includes(record.phase)) return { record, ready: false };
      if (record.phase !== "prepared" && !(resume && record.phase === "failed"))
        throw new DeliveryError("conflict", 409);
      if (record.plan.expiresAt <= this.now()) throw new DeliveryError("planExpired", 409);
      return { record, ready: true };
    });
  }
  async queue(
    owner: string,
    id: string,
    fingerprint: string,
    authorize: (plan: WorkflowPlan) => void | Promise<Awaited<void>>,
    resume = false,
    confirmation: JsonValue = null,
  ) {
    return await this.db.atomic(async () => {
      const details = workflowJson(confirmation, 8192);
      return await this.db.atomic(async () => {
        const { record, ready } = await this.queueState(owner, id, fingerprint, resume);
        if (!ready) return record;
        await authorize(record.plan);
        if (resume) await this.steps.allowRetry(id);
        await this.db.execute(
          "INSERT INTO panda_force_publication_confirmations(jobId,actor,fingerprint,createdAt,resume,details) VALUES(?,?,?,?,?,?)",
          [id, owner, fingerprint, this.now(), Number(resume), details],
        );
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase='queued',error=NULL,updatedAt=? WHERE id=?",
          [this.now(), id],
        );
        return await this.get(id);
      });
    });
  }
  async finish(
    lease: PublicationLease,
    phase: "completed" | "failed" | "needsAttention" | "cancelled",
    receipt: JsonValue,
    error: string | null,
  ) {
    return await this.db.atomic(async () => {
      const payload = workflowJson(receipt, 128 * 1024);
      if (error && !/^[a-z][a-zA-Z0-9]{0,80}$/.test(error)) throw new DeliveryError("invalidInput");
      return await this.leases.guard(lease, async () => {
        const steps = await this.steps.effective(lease.id),
          latest = new Map(steps.map((step) => [step.key, step]));
        const cancellation = await this.cancellations.get(lease.id);
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
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase=?,receipt=?,error=?,updatedAt=?,leaseUntil=0 WHERE id=?",
          [phase, payload, error, this.now(), lease.id],
        );
        return await this.get(lease.id);
      });
    });
  }
  async wait(lease: PublicationLease, until: number) {
    return await this.db.atomic(async () => {
      return await this.leases.guard(lease, async () => {
        await this.cancellations.assertContinuing(lease.id);
        if (!Number.isSafeInteger(until) || until <= this.now() || until > this.now() + 3600000)
          throw new DeliveryError("invalidInput");
        if ((await this.steps.effective(lease.id)).some((step) => step.outcome === "pending"))
          throw new DeliveryError("outcomeUnknown", 409);
        if (until >= (await this.get(lease.id)).plan.expiresAt) throw new DeliveryError("planExpired", 409);
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase='waiting',nextRunAt=?,error=NULL,updatedAt=?,leaseUntil=0 WHERE id=?",
          [until, this.now(), lease.id],
        );
        return await this.get(lease.id);
      });
    });
  }
  async cancel(owner: string, id: string) {
    return await this.db.atomic(async () => {
      await this.cancellations.request(owner, id);
      return await this.owned(owner, id);
    });
  }
}
