import type { Database } from "bun:sqlite";
import type { BuildArtifact } from "../../shared/builds/contracts.js";
import type {
  SitePublicationPlan,
  SitePublicationRequest,
  SitePublication,
  PublicationJob,
  PublicationReceipt,
} from "../../shared/delivery/contracts.js";
import { DeliveryError } from "./errors.js";
import { initializePublicationSchema } from "./storage/schema.js";
import { PublicationLeases, type PublicationLease } from "./storage/leases.js";
import { PublicationEffects } from "./storage/effects.js";
import { PublicationSnapshots } from "./storage/snapshots.js";
export type { PublicationLease } from "./storage/leases.js";

const terminal = (phase: string) => ["published", "failed", "cancelled"].includes(phase);
type Stored = { ownerId: string; record: string; request: string; artifactHash: string | null };
type JobRow = {
  id: string;
  phase: PublicationJob["phase"];
  step: PublicationJob["step"];
  updatedAt: number;
  error: string | null;
  receipt: string | null;
  checkOnly: number;
};

/** Frozen bytes are transactionally pinned until a terminal outcome. The bounded store works without a queue service. */
export class PublicationRepository {
  private leases: PublicationLeases;
  private effects: PublicationEffects;
  private snapshots: PublicationSnapshots;
  constructor(
    private db: Database,
    private now = Date.now,
  ) {
    initializePublicationSchema(db);
    this.leases = new PublicationLeases(db, now);
    this.effects = new PublicationEffects(db, this.leases, now);
    this.snapshots = new PublicationSnapshots(db);
  }
  private row(id: string) {
    const row = this.db
      .query<Stored, [string]>(
        "SELECT ownerId,record,request,artifactHash FROM publication_plans WHERE kind='site' AND id=?",
      )
      .get(id);
    if (!row) throw new DeliveryError("notFound", 404);
    return row;
  }
  get(id: string): SitePublication {
    const row = this.row(id),
      job = this.db
        .query<JobRow, [string]>(
          "SELECT id,phase,step,updatedAt,error,receipt,checkOnly FROM publication_jobs WHERE id=?",
        )
        .get(id)!;
    const { checkOnly, ...record } = job;
    return {
      plan: JSON.parse(row.record),
      job: {
        ...record,
        phase: checkOnly && ["queued", "running"].includes(job.phase) ? "reconciling" : job.phase,
        receipt: job.receipt ? JSON.parse(job.receipt) : null,
      },
    };
  }
  owned(ownerId: string, id: string) {
    if (this.row(id).ownerId !== ownerId) throw new DeliveryError("notFound", 404);
    return this.get(id);
  }
  owner(id: string) {
    return this.row(id).ownerId;
  }
  existing(ownerId: string, request: SitePublicationRequest) {
    if (!this.db.query("SELECT id FROM publication_plans WHERE id=?").get(request.id)) return null;
    const value = this.owned(ownerId, request.id);
    if (this.row(request.id).request !== JSON.stringify(request)) throw new DeliveryError("conflict", 409);
    return value;
  }
  prepare(ownerId: string, request: SitePublicationRequest, plan: SitePublicationPlan, artifact: BuildArtifact) {
    const payload = JSON.stringify(artifact);
    return this.db
      .transaction(() => {
        const existing = this.existing(ownerId, request);
        if (existing) return existing;
        const count = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM publication_plans").get()!
          .count;
        if (count >= 1000) throw new DeliveryError("historyFull", 507);
        const hash = this.snapshots.put(payload);
        this.db
          .query(
            "INSERT INTO publication_plans(id,ownerId,spaceId,connectionId,record,request,artifactHash,sourceProjectId) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            plan.id,
            ownerId,
            plan.spaceId,
            plan.connectionId,
            JSON.stringify(plan),
            JSON.stringify(request),
            hash,
            plan.sourceProjectId ?? null,
          );
        this.db
          .query("INSERT INTO publication_jobs(id,phase,updatedAt) VALUES(?,'prepared',?)")
          .run(plan.id, this.now());
        return this.get(plan.id);
      })
      .immediate();
  }
  list(ownerId: string, spaceId: string, projectId?: string) {
    return this.db
      .query<{ id: string }, [string, string, string | null]>(
        "SELECT id FROM publication_plans WHERE kind='site' AND ownerId=? AND spaceId=? AND sourceProjectId IS ? ORDER BY rowid DESC LIMIT 50",
      )
      .all(ownerId, spaceId, projectId ?? null)
      .map((row) => this.get(row.id));
  }
  queue(ownerId: string, id: string, authorize: (plan: SitePublicationPlan) => void) {
    return this.db
      .transaction(() => {
        const record = this.owned(ownerId, id);
        if (["queued", "running", "published"].includes(record.job.phase)) return record;
        if (record.job.phase !== "prepared") throw new DeliveryError("conflict", 409);
        if (record.plan.expiresAt <= this.now()) throw new DeliveryError("planExpired", 409);
        authorize(record.plan);
        const competing = this.db
          .query(
            "SELECT j.id FROM publication_jobs j JOIN publication_plans p ON p.id=j.id WHERE p.kind='site' AND p.connectionId=? AND j.phase IN ('queued','running','needsAttention')",
          )
          .get(record.plan.connectionId);
        if (competing) throw new DeliveryError("targetBusy", 409);
        this.db.query("UPDATE publication_jobs SET phase='queued',updatedAt=? WHERE id=?").run(this.now(), id);
        return this.get(id);
      })
      .immediate();
  }
  cancel(ownerId: string, id: string, authorize: () => void) {
    return this.db
      .transaction(() => {
        const record = this.owned(ownerId, id);
        authorize();
        if (record.job.phase === "cancelled") return record;
        if (!["prepared", "queued"].includes(record.job.phase)) throw new DeliveryError("alreadyStarted", 409);
        this.db.query("UPDATE publication_jobs SET phase='cancelled',updatedAt=? WHERE id=?").run(this.now(), id);
        this.snapshots.release(id);
        return this.get(id);
      })
      .immediate();
  }
  reconcile(ownerId: string, id: string, authorize: () => void, cleanup = false) {
    return this.db
      .transaction(() => {
        const record = this.owned(ownerId, id);
        authorize();
        if (record.job.phase === "reconciling" || record.job.phase === "published") return record;
        if (record.job.phase !== "needsAttention") throw new DeliveryError("conflict", 409);
        this.db
          .query("UPDATE publication_jobs SET phase='queued',checkOnly=?,updatedAt=? WHERE id=?")
          .run(cleanup ? 2 : 1, this.now(), id);
        return this.get(id);
      })
      .immediate();
  }
  acquire() {
    return this.leases.acquire();
  }
  guard<T>(lease: PublicationLease, operation: () => T): T {
    return this.leases.guard(lease, operation);
  }
  step(lease: PublicationLease, step: "staging" | "activating") {
    this.leases.step(lease, step);
  }
  remoteIntent(lease: PublicationLease, operation: string) {
    return this.effects.intent(lease, operation);
  }
  remoteAcknowledged(lease: PublicationLease, id: number) {
    this.effects.acknowledged(lease, id);
  }
  snapshot(id: string): BuildArtifact {
    return JSON.parse(this.snapshots.get(this.row(id).artifactHash));
  }
  finish(
    lease: PublicationLease,
    phase: "published" | "failed" | "needsAttention",
    receipt: PublicationReceipt | null,
    error: string | null,
  ) {
    return this.guard(lease, () => {
      this.db
        .query("UPDATE publication_jobs SET phase=?,updatedAt=?,error=?,receipt=?,leaseUntil=0 WHERE id=?")
        .run(phase, this.now(), error, receipt ? JSON.stringify(receipt) : null, lease.id);
      if (terminal(phase)) this.snapshots.release(lease.id);
      return this.get(lease.id);
    });
  }
  expire() {
    this.db
      .transaction(() => {
        const rows = this.db
          .query<{ id: string; record: string }, []>(
            "SELECT p.id,p.record FROM publication_plans p JOIN publication_jobs j ON j.id=p.id WHERE p.kind='site' AND j.phase='prepared'",
          )
          .all();
        for (const row of rows)
          if ((JSON.parse(row.record) as SitePublicationPlan).expiresAt <= this.now()) {
            this.db
              .query("UPDATE publication_jobs SET phase='failed',error='planExpired',updatedAt=? WHERE id=?")
              .run(this.now(), row.id);
            this.snapshots.release(row.id);
          }
      })
      .immediate();
  }
}
