import type { BuildArtifact } from "../../shared/builds/contracts.js";
import type {
  PublicationJob,
  PublicationReceipt,
  SitePublication,
  SitePublicationPlan,
  SitePublicationRequest,
} from "../../shared/delivery/contracts.js";
import type { MySQLSession } from "../database/mysql-session.js";
import { DeliveryError } from "./errors.js";
import { MySQLPublicationEffects } from "./storage/mysql-effects.js";
import { MySQLPublicationLeases, type PublicationLease } from "./storage/mysql-leases.js";
import { MySQLPublicationSnapshots } from "./storage/mysql-snapshots.js";
export type { PublicationLease } from "./storage/leases.js";
const terminal = (phase: string) => ["published", "failed", "cancelled"].includes(phase);
type Stored = {
  ownerId: string;
  record: string;
  request: string;
  artifactHash: string | null;
};
type JobRow = {
  id: string;
  phase: PublicationJob["phase"];
  step: PublicationJob["step"];
  updatedAt: number;
  error: string | null;
  receipt: string | null;
  checkOnly: number;
};
function publicationView(record: string, job: JobRow): SitePublication {
  if (!job.id) throw new DeliveryError("unavailable", 503);
  const { checkOnly, ...value } = job;
  return {
    plan: JSON.parse(record),
    job: {
      ...value,
      phase: checkOnly && ["queued", "running"].includes(job.phase) ? "reconciling" : job.phase,
      receipt: job.receipt ? JSON.parse(job.receipt) : null,
    },
  };
}
/** Frozen bytes are transactionally pinned until a terminal outcome. The bounded store works without a queue service. */
export class MySQLPublicationRepository {
  private leases: MySQLPublicationLeases;
  private effects: MySQLPublicationEffects;
  private snapshots: MySQLPublicationSnapshots;
  constructor(
    private db: MySQLSession,
    private now = Date.now,
  ) {
    this.leases = new MySQLPublicationLeases(db, now);
    this.effects = new MySQLPublicationEffects(db, this.leases, now);
    this.snapshots = new MySQLPublicationSnapshots(db);
  }
  private async row(id: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<Stored>(
        "SELECT ownerId,record,request,artifactHash FROM panda_force_publication_plans WHERE kind='site' AND id=?",
        [id],
      );
      if (!row) throw new DeliveryError("notFound", 404);
      return row;
    });
  }
  async get(id: string): Promise<SitePublication> {
    return await this.db.atomic(async () => {
      const row = await this.row(id),
        job = (await this.db.one<JobRow>(
          "SELECT id,phase,step,updatedAt,error,receipt,checkOnly FROM panda_force_publication_jobs WHERE id=?",
          [id],
        ))!;
      return publicationView(row.record, job);
    });
  }
  async owned(ownerId: string, id: string) {
    return await this.db.atomic(async () => {
      if ((await this.row(id)).ownerId !== ownerId) throw new DeliveryError("notFound", 404);
      return await this.get(id);
    });
  }
  async owner(id: string) {
    return await this.db.atomic(async () => {
      return (await this.row(id)).ownerId;
    });
  }
  async existing(ownerId: string, request: SitePublicationRequest) {
    return await this.db.atomic(async () => {
      if (!(await this.db.one("SELECT id FROM panda_force_publication_plans WHERE id=?", [request.id]))) return null;
      const value = await this.owned(ownerId, request.id);
      if ((await this.row(request.id)).request !== JSON.stringify(request)) throw new DeliveryError("conflict", 409);
      return value;
    });
  }
  async prepare(
    ownerId: string,
    request: SitePublicationRequest,
    plan: SitePublicationPlan,
    artifact: BuildArtifact,
    authorize: () => void | Promise<void>,
  ) {
    return await this.db.atomic(async () => {
      const payload = JSON.stringify(artifact);
      return await this.db.atomic(async () => {
        await authorize();
        const existing = await this.existing(ownerId, request);
        if (existing) return existing;
        const count = (await this.db.one<{
          count: number;
        }>("SELECT count(*) AS count FROM panda_force_publication_plans", []))!.count;
        if (count >= 1000) throw new DeliveryError("historyFull", 507);
        const hash = await this.snapshots.put(payload);
        await this.db.execute(
          "INSERT INTO panda_force_publication_plans(id,ownerId,spaceId,connectionId,record,request,artifactHash,sourceProjectId) VALUES(?,?,?,?,?,?,?,?)",
          [
            plan.id,
            ownerId,
            plan.spaceId,
            plan.connectionId,
            JSON.stringify(plan),
            JSON.stringify(request),
            hash,
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
  async list(ownerId: string, spaceId: string, projectId?: string) {
    return await this.db.atomic(async () => {
      const rows = await this.db.all<JobRow & { record: string }>(
        "SELECT p.record,j.id,j.phase,j.step,j.updatedAt,j.error,j.receipt,j.checkOnly FROM panda_force_publication_plans p LEFT JOIN panda_force_publication_jobs j ON j.id=p.id WHERE p.kind='site' AND p.ownerId=? AND p.spaceId=? AND p.sourceProjectId <=> ? ORDER BY p.rowSequence DESC LIMIT 50",
        [ownerId, spaceId, projectId ?? null],
      );
      return rows.map(({ record, ...job }) => publicationView(record, job));
    });
  }
  async queue(ownerId: string, id: string, authorize: (plan: SitePublicationPlan) => void | Promise<Awaited<void>>) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const record = await this.owned(ownerId, id);
        if (["queued", "running", "published"].includes(record.job.phase)) return record;
        if (record.job.phase !== "prepared") throw new DeliveryError("conflict", 409);
        if (record.plan.expiresAt <= this.now()) throw new DeliveryError("planExpired", 409);
        await authorize(record.plan);
        const competing = await this.db.one(
          "SELECT j.id FROM panda_force_publication_jobs j JOIN panda_force_publication_plans p ON p.id=j.id WHERE p.kind='site' AND p.connectionId=? AND j.phase IN ('queued','running','needsAttention')",
          [record.plan.connectionId],
        );
        if (competing) throw new DeliveryError("targetBusy", 409);
        await this.db.execute("UPDATE panda_force_publication_jobs SET phase='queued',updatedAt=? WHERE id=?", [
          this.now(),
          id,
        ]);
        return await this.get(id);
      });
    });
  }
  async cancel(ownerId: string, id: string, authorize: () => void | Promise<Awaited<void>>) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const record = await this.owned(ownerId, id);
        await authorize();
        if (record.job.phase === "cancelled") return record;
        if (!["prepared", "queued"].includes(record.job.phase)) throw new DeliveryError("alreadyStarted", 409);
        await this.db.execute("UPDATE panda_force_publication_jobs SET phase='cancelled',updatedAt=? WHERE id=?", [
          this.now(),
          id,
        ]);
        await this.snapshots.release(id);
        return await this.get(id);
      });
    });
  }
  async reconcile(ownerId: string, id: string, authorize: () => void | Promise<Awaited<void>>, cleanup = false) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const record = await this.owned(ownerId, id);
        await authorize();
        if (record.job.phase === "reconciling" || record.job.phase === "published") return record;
        if (record.job.phase !== "needsAttention") throw new DeliveryError("conflict", 409);
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase='queued',checkOnly=?,updatedAt=? WHERE id=?",
          [cleanup ? 2 : 1, this.now(), id],
        );
        return await this.get(id);
      });
    });
  }
  async acquire() {
    return await this.db.atomic(async () => {
      return await this.leases.acquire();
    });
  }
  async releaseLease(lease: PublicationLease) {
    await this.leases.release(lease);
  }
  async guard<T>(lease: PublicationLease, operation: () => T | Promise<T>): Promise<T> {
    return await this.db.atomic(async () => {
      return await this.leases.guard(lease, operation);
    });
  }
  async step(lease: PublicationLease, step: "staging" | "activating") {
    return await this.db.atomic(async () => {
      await this.leases.step(lease, step);
    });
  }
  async remoteIntent(lease: PublicationLease, operation: string) {
    return await this.db.atomic(async () => {
      return await this.effects.intent(lease, operation);
    });
  }
  async remoteAcknowledged(lease: PublicationLease, id: number) {
    return await this.db.atomic(async () => {
      await this.effects.acknowledged(lease, id);
    });
  }
  async snapshot(id: string): Promise<BuildArtifact> {
    return await this.db.atomic(async () => {
      return JSON.parse(await this.snapshots.get((await this.row(id)).artifactHash));
    });
  }
  async finish(
    lease: PublicationLease,
    phase: "published" | "failed" | "needsAttention",
    receipt: PublicationReceipt | null,
    error: string | null,
  ) {
    return await this.db.atomic(async () => {
      return await this.guard(lease, async () => {
        await this.db.execute(
          "UPDATE panda_force_publication_jobs SET phase=?,updatedAt=?,error=?,receipt=?,leaseUntil=0 WHERE id=?",
          [phase, this.now(), error, receipt ? JSON.stringify(receipt) : null, lease.id],
        );
        if (terminal(phase)) await this.snapshots.release(lease.id);
        return await this.get(lease.id);
      });
    });
  }
  async expire() {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const rows = await this.db.all<{
          id: string;
          record: string;
        }>(
          "SELECT p.id,p.record FROM panda_force_publication_plans p JOIN panda_force_publication_jobs j ON j.id=p.id WHERE p.kind='site' AND j.phase='prepared'",
          [],
        );
        for (const row of rows)
          if ((JSON.parse(row.record) as SitePublicationPlan).expiresAt <= this.now()) {
            await this.db.execute(
              "UPDATE panda_force_publication_jobs SET phase='failed',error='planExpired',updatedAt=? WHERE id=?",
              [this.now(), row.id],
            );
            await this.snapshots.release(row.id);
          }
      });
    });
  }
}
