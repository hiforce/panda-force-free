import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { EditorialJobFailure } from "../../../shared/editorial/jobs.js";
import { EditorialError } from "../errors.js";
import { migrateEditorial } from "../schema.js";
import {
  EditorialLeaseLost,
  type EditorialClaim,
  type EditorialJobRecord,
  type EditorialJobRow,
  type EditorialJobSpec,
} from "./contracts.js";

const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");
/** Network work never runs in these transactions. Expiring leases fence cancelled and superseded executions. */
export class EditorialJobRepository {
  constructor(private db: Database) {
    migrateEditorial(db);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  private record(row: EditorialJobRow): EditorialJobRecord {
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
  get(owner: string, id: string): EditorialJobRecord {
    const row = this.db
      .query<EditorialJobRow, [string, string]>("SELECT * FROM editorial_jobs WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) throw new EditorialError("notFound", 404);
    return this.record(row);
  }
  existing(owner: string, id: string, request: string) {
    const row = this.db.query<EditorialJobRow, [string]>("SELECT * FROM editorial_jobs WHERE id=?").get(id);
    if (!row) return null;
    if (row.owner !== owner) throw new EditorialError("notFound", 404);
    if (row.request !== request) throw new EditorialError("invalidInput", 409);
    return this.record(row);
  }
  private capacity(owner: string) {
    const active = this.db
      .query<{ own: number; total: number }, [string]>(
        "SELECT COALESCE(SUM(owner=?),0) AS own,COUNT(*) AS total FROM editorial_jobs WHERE state IN ('queued','running')",
      )
      .get(owner)!;
    if (active.own >= 32 || active.total >= 256) throw new EditorialError("unavailable", 503);
  }
  create(owner: string, request: string, spec: EditorialJobSpec, now: number) {
    return this.transaction(() => {
      const existing = this.existing(owner, spec.id, request);
      if (existing) return existing;
      this.capacity(owner);
      const payload = JSON.stringify(spec);
      this.db
        .query(
          "INSERT INTO editorial_jobs(id,owner,documentId,request,payload,digest,state,createdAt,updatedAt,sourceProjectId) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
        )
        .run(
          spec.id,
          owner,
          spec.source.ref.documentId,
          request,
          payload,
          digest(payload),
          now,
          now,
          spec.source.ref.projectId ?? null,
        );
      return this.get(owner, spec.id);
    });
  }
  list(owner: string, documentId: string, projectId?: string) {
    return this.db
      .query<EditorialJobRow, [string, string, string | null]>(
        "SELECT * FROM editorial_jobs WHERE owner=? AND documentId=? AND sourceProjectId IS ? ORDER BY createdAt DESC,rowid DESC LIMIT 50",
      )
      .all(owner, documentId, projectId ?? null)
      .map((row) => this.record(row).job);
  }
  claim(now: number, leaseMs: number): EditorialClaim | null {
    return this.transaction(() => {
      this.db
        .query(
          `UPDATE editorial_jobs SET state=CASE WHEN budget>0 THEN 'queued' ELSE 'failed' END,
        failure=CASE WHEN budget>0 THEN NULL ELSE 'interrupted' END,leaseToken=NULL,leaseUntil=NULL,updatedAt=?
        WHERE state='running' AND leaseUntil<=?`,
        )
        .run(now, now);
      const row = this.db
        .query<EditorialJobRow, []>(
          "SELECT * FROM editorial_jobs WHERE state='queued' ORDER BY createdAt,rowid LIMIT 1",
        )
        .get();
      if (!row) return null;
      const token = randomUUID();
      this.db
        .query(
          "UPDATE editorial_jobs SET state='running',attempts=attempts+1,budget=budget-1,leaseToken=?,leaseUntil=?,updatedAt=? WHERE id=? AND state='queued'",
        )
        .run(token, now + leaseMs, now, row.id);
      return { ...this.get(row.owner, row.id), token };
    });
  }
  heartbeat(claim: EditorialClaim, now: number, leaseMs: number): boolean {
    return (
      this.db
        .query(
          "UPDATE editorial_jobs SET leaseUntil=?,updatedAt=? WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?",
        )
        .run(now + leaseMs, now, claim.row.id, claim.token, now).changes === 1
    );
  }
  complete(claim: EditorialClaim, now: number, proposal: () => string) {
    return this.transaction(() => {
      const current = this.get(claim.row.owner, claim.row.id);
      if (
        current.row.state !== "running" ||
        current.row.leaseToken !== claim.token ||
        (current.row.leaseUntil || 0) <= now
      )
        throw new EditorialLeaseLost("leaseLost");
      const proposalId = proposal();
      this.db
        .query(
          "UPDATE editorial_jobs SET state='succeeded',proposalId=?,failure=NULL,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",
        )
        .run(proposalId, now, claim.row.id);
      return this.get(claim.row.owner, claim.row.id).job;
    });
  }
  fail(claim: EditorialClaim, now: number, failure: EditorialJobFailure): boolean {
    return (
      this.db
        .query(
          "UPDATE editorial_jobs SET state='failed',failure=?,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?",
        )
        .run(failure, now, claim.row.id, claim.token, now).changes === 1
    );
  }
  release(claim: EditorialClaim, now: number): boolean {
    return (
      this.db
        .query(
          `UPDATE editorial_jobs SET state=CASE WHEN budget>0 THEN 'queued' ELSE 'failed' END,
      failure=CASE WHEN budget>0 THEN NULL ELSE 'interrupted' END,leaseToken=NULL,leaseUntil=NULL,updatedAt=?
      WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?`,
        )
        .run(now, claim.row.id, claim.token, now).changes === 1
    );
  }
  cancel(owner: string, id: string, now: number) {
    return this.transaction(() => {
      this.get(owner, id);
      this.db
        .query(
          "UPDATE editorial_jobs SET state='cancelled',failure=NULL,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=? AND state IN ('queued','running')",
        )
        .run(now, id);
      return this.get(owner, id).job;
    });
  }
  retried(owner: string, id: string, retryId: string) {
    this.get(owner, id);
    return !!this.db.query("SELECT 1 FROM editorial_job_retries WHERE jobId=? AND retryId=?").get(id, retryId);
  }
  retry(owner: string, id: string, retryId: string, now: number) {
    return this.transaction(() => {
      const record = this.get(owner, id);
      if (this.retried(owner, id, retryId)) return record.job;
      if (!["failed", "cancelled"].includes(record.job.state) || record.job.generation >= 100)
        throw new EditorialError("invalidInput", 409);
      this.capacity(owner);
      this.db.query("INSERT INTO editorial_job_retries(jobId,retryId) VALUES(?,?)").run(id, retryId);
      this.db
        .query(
          "UPDATE editorial_jobs SET state='queued',generation=generation+1,budget=3,failure=NULL,updatedAt=? WHERE id=?",
        )
        .run(now, id);
      return this.get(owner, id).job;
    });
  }
}
