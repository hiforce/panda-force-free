import type { MySQLEditorialSession } from "../mysql-session.js";
import { createHash, randomUUID } from "node:crypto";
import type { EditorialJobFailure } from "../../../shared/editorial/jobs.js";
import { EditorialError } from "../errors.js";
import {
  EditorialLeaseLost,
  type EditorialClaim,
  type EditorialJobRecord,
  type EditorialJobRow,
  type EditorialJobSpec,
} from "./contracts.js";
const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");
/** Network work never runs in these transactions. Expiring leases fence cancelled and superseded executions. */
export class MySQLEditorialJobRepository {
  constructor(private db: MySQLEditorialSession) {}
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
  private async record(row: EditorialJobRow): Promise<EditorialJobRecord> {
    if (digest(row.payload) !== row.digest) throw new EditorialError("unavailable", 503);
    const spec = JSON.parse(row.payload) as EditorialJobSpec;
    if (
      spec.id !== row.id ||
      spec.source.ref.documentId !== row.documentId ||
      (spec.source.ref.projectId ?? null) !== row.sourceProjectId
    )
      throw new EditorialError("unavailable", 503);
    return {
      row,
      spec,
      job: {
        id: row.id,
        source: spec.source.ref,
        mode: spec.mode,
        profile: spec.profile,
        state: row.state,
        attempts: row.attempts,
        generation: row.generation,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        proposalId: row.proposalId,
        failure: row.failure,
      },
    };
  }
  async get(owner: string, id: string): Promise<EditorialJobRecord> {
    const row = await this.db.one<EditorialJobRow>("SELECT * FROM panda_force_editorial_jobs WHERE id=? AND owner=?", [
      id,
      owner,
    ]);
    if (!row) throw new EditorialError("notFound", 404);
    return await this.record(row);
  }
  async existing(owner: string, id: string, request: string) {
    const row = await this.db.one<EditorialJobRow>("SELECT * FROM panda_force_editorial_jobs WHERE id=?", [id]);
    if (!row) return null;
    if (row.owner !== owner) throw new EditorialError("notFound", 404);
    if (row.request !== request) throw new EditorialError("invalidInput", 409);
    return await this.record(row);
  }
  private async capacity(owner: string) {
    const active = (await this.db.one<{
      own: number;
      total: number;
    }>(
      "SELECT COALESCE(SUM(owner=?),0) AS own,COUNT(*) AS total FROM panda_force_editorial_jobs WHERE state IN ('queued','running')",
      [owner],
    ))!;
    if (active.own >= 32 || active.total >= 256) throw new EditorialError("unavailable", 503);
  }
  async create(owner: string, request: string, spec: EditorialJobSpec, now: number) {
    return await this.transaction(async () => {
      const existing = await this.existing(owner, spec.id, request);
      if (existing) return existing;
      await this.capacity(owner);
      const payload = JSON.stringify(spec);
      await this.db.run(
        "INSERT INTO panda_force_editorial_jobs(id,owner,documentId,request,payload,digest,state,createdAt,updatedAt,sourceProjectId) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
        [
          spec.id,
          owner,
          spec.source.ref.documentId,
          request,
          payload,
          digest(payload),
          now,
          now,
          spec.source.ref.projectId ?? null,
        ],
      );
      return await this.get(owner, spec.id);
    });
  }
  async list(owner: string, documentId: string, projectId?: string) {
    return await Promise.all(
      (
        await this.db.all<EditorialJobRow>(
          "SELECT * FROM panda_force_editorial_jobs WHERE owner=? AND documentId=? AND sourceProjectId <=> ? ORDER BY createdAt DESC,sequence DESC LIMIT 50",
          [owner, documentId, projectId ?? null],
        )
      ).map(async (row) => (await this.record(row)).job),
    );
  }
  async claim(now: number, leaseMs: number): Promise<EditorialClaim | null> {
    return await this.transaction(async () => {
      await this.db.run(
        `UPDATE panda_force_editorial_jobs SET state=CASE WHEN budget>0 THEN 'queued' ELSE 'failed' END,
        failure=CASE WHEN budget>0 THEN NULL ELSE 'interrupted' END,leaseToken=NULL,leaseUntil=NULL,updatedAt=?
        WHERE state='running' AND leaseUntil<=?`,
        [now, now],
      );
      const row = await this.db.one<EditorialJobRow>(
        "SELECT * FROM panda_force_editorial_jobs WHERE state='queued' ORDER BY createdAt,sequence LIMIT 1",
        [],
      );
      if (!row) return null;
      const token = randomUUID();
      await this.db.run(
        "UPDATE panda_force_editorial_jobs SET state='running',attempts=attempts+1,budget=budget-1,leaseToken=?,leaseUntil=?,updatedAt=? WHERE id=? AND state='queued'",
        [token, now + leaseMs, now, row.id],
      );
      return { ...(await this.get(row.owner, row.id)), token };
    });
  }
  async heartbeat(claim: EditorialClaim, now: number, leaseMs: number): Promise<boolean> {
    return (
      (
        await this.db.run(
          "UPDATE panda_force_editorial_jobs SET leaseUntil=?,updatedAt=? WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?",
          [now + leaseMs, now, claim.row.id, claim.token, now],
        )
      ).changes === 1
    );
  }
  async complete(claim: EditorialClaim, now: number, proposal: () => string | Promise<string>) {
    return await this.transaction(async () => {
      const current = await this.get(claim.row.owner, claim.row.id);
      if (
        current.row.state !== "running" ||
        current.row.leaseToken !== claim.token ||
        (current.row.leaseUntil || 0) <= now
      )
        throw new EditorialLeaseLost("leaseLost");
      const proposalId = await proposal();
      await this.db.run(
        "UPDATE panda_force_editorial_jobs SET state='succeeded',proposalId=?,failure=NULL,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",
        [proposalId, now, claim.row.id],
      );
      return (await this.get(claim.row.owner, claim.row.id)).job;
    });
  }
  async fail(claim: EditorialClaim, now: number, failure: EditorialJobFailure): Promise<boolean> {
    return (
      (
        await this.db.run(
          "UPDATE panda_force_editorial_jobs SET state='failed',failure=?,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?",
          [failure, now, claim.row.id, claim.token, now],
        )
      ).changes === 1
    );
  }
  async release(claim: EditorialClaim, now: number): Promise<boolean> {
    return (
      (
        await this.db.run(
          `UPDATE panda_force_editorial_jobs SET state=CASE WHEN budget>0 THEN 'queued' ELSE 'failed' END,
      failure=CASE WHEN budget>0 THEN NULL ELSE 'interrupted' END,leaseToken=NULL,leaseUntil=NULL,updatedAt=?
      WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?`,
          [now, claim.row.id, claim.token, now],
        )
      ).changes === 1
    );
  }
  async cancel(owner: string, id: string, now: number) {
    return await this.transaction(async () => {
      await this.get(owner, id);
      await this.db.run(
        "UPDATE panda_force_editorial_jobs SET state='cancelled',failure=NULL,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=? AND state IN ('queued','running')",
        [now, id],
      );
      return (await this.get(owner, id)).job;
    });
  }
  async retried(owner: string, id: string, retryId: string) {
    await this.get(owner, id);
    return !!(await this.db.one("SELECT 1 FROM panda_force_editorial_job_retries WHERE jobId=? AND retryId=?", [
      id,
      retryId,
    ]));
  }
  async retry(owner: string, id: string, retryId: string, now: number) {
    return await this.transaction(async () => {
      const record = await this.get(owner, id);
      if (await this.retried(owner, id, retryId)) return record.job;
      if (!["failed", "cancelled"].includes(record.job.state) || record.job.generation >= 100)
        throw new EditorialError("invalidInput", 409);
      await this.capacity(owner);
      await this.db.run("INSERT INTO panda_force_editorial_job_retries(jobId,retryId) VALUES(?,?)", [id, retryId]);
      await this.db.run(
        "UPDATE panda_force_editorial_jobs SET state='queued',generation=generation+1,budget=3,failure=NULL,updatedAt=? WHERE id=?",
        [now, id],
      );
      return (await this.get(owner, id)).job;
    });
  }
}
