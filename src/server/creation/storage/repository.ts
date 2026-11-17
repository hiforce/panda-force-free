import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import {
  CreationError,
  type CreationArtifact,
  type CreationExecution,
  type CreationFailure,
  type CreationLease,
} from "../contracts.js";
import type { CreationOutputTasks } from "../ports.js";
import {
  creationArtifact,
  creationDigest,
  creationInteger,
  creationTaskSpec,
  creationText,
  creationUuid,
} from "../validation.js";
import { creationSignature, creationTask, readCreationTask, type CreationTaskRow } from "./records.js";

/** Short metadata transactions never contain model requests, filesystem work or Git operations. */
export class CreationTaskRepository implements CreationOutputTasks {
  constructor(private readonly db: Database) {}
  private transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  private row(owner: string, id: string): CreationTaskRow {
    return readCreationTask(this.db, owner, id);
  }
  get(owner: string, id: string) {
    return creationTask(this.row(owner, id));
  }
  find(owner: string, id: string) {
    const row = this.db
      .query<CreationTaskRow, [string]>("SELECT * FROM creation_tasks WHERE id=?")
      .get(creationUuid(id));
    if (!row) return null;
    if (row.owner !== creationText(owner)) throw new CreationError("notFound");
    return creationTask(row);
  }
  /** Only an authorized application use case supplies this spec; it is never model tool input. */
  create(value: unknown, now: number) {
    const spec = creationTaskSpec(value),
      signature = creationSignature(spec);
    creationInteger(now);
    return this.transaction(() => {
      const prior = this.db.query<CreationTaskRow, [string]>("SELECT * FROM creation_tasks WHERE id=?").get(spec.id);
      if (prior) {
        if (prior.owner !== spec.owner) throw new CreationError("notFound");
        if (prior.signature !== signature) throw new CreationError("conflict");
        return creationTask(prior);
      }
      const active = this.db
        .query<{ own: number; total: number }, [string]>(
          "SELECT COALESCE(SUM(owner=?),0) AS own,COUNT(*) AS total FROM creation_tasks WHERE state IN ('queued','running','committing')",
        )
        .get(spec.owner)!;
      if (active.own >= 32 || active.total >= 256) throw new CreationError("unavailable");
      if (this.db.query("SELECT 1 FROM creation_tasks WHERE operationId=?").get(spec.operationId))
        throw new CreationError("conflict");
      this.db
        .query(
          "INSERT INTO creation_tasks(id,owner,projectId,operationId,spec,signature,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'queued',?,?)",
        )
        .run(spec.id, spec.owner, spec.projectId, spec.operationId, stableJson(spec), signature, now, now);
      return this.get(spec.owner, spec.id);
    });
  }
  claim(owner: string, id: string, now: number, leaseMs: number): CreationLease {
    creationInteger(now);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) throw new CreationError("invalidInput");
    return this.transaction(() => {
      const row = this.row(owner, id);
      if (row.cancelRequested || !(row.state === "queued" || (row.state === "running" && (row.leaseUntil ?? 0) <= now)))
        throw new CreationError("conflict");
      if (row.budget <= 0) throw new CreationError("unavailable");
      if (this.db.query("SELECT 1 FROM creation_questions WHERE taskId=? AND state='pending'").get(id))
        throw new CreationError("conflict");
      const token = randomUUID(),
        generation = row.generation + 1;
      this.db
        .query(
          "UPDATE creation_tasks SET state='running',generation=?,attempts=attempts+1,budget=budget-1,token=?,leaseUntil=?,sessionId=NULL,runId=NULL,failure=NULL,updatedAt=? WHERE id=?",
        )
        .run(generation, token, now + leaseMs, now, row.id);
      return { taskId: row.id, owner: row.owner, generation, token };
    });
  }
  private active(lease: CreationLease, now: number): CreationTaskRow {
    creationInteger(now);
    const row = this.row(lease.owner, lease.taskId);
    if (
      !["running", "committing"].includes(row.state) ||
      row.cancelRequested ||
      row.generation !== lease.generation ||
      row.token !== lease.token ||
      (row.leaseUntil ?? 0) <= now
    )
      throw new CreationError("leaseLost");
    return row;
  }
  bind(lease: CreationLease, sessionId: string, runId: string, now: number): CreationExecution {
    sessionId = creationText(sessionId, 128);
    runId = creationText(runId, 128);
    return this.transaction(() => {
      const row = this.active(lease, now);
      if ((row.sessionId !== null && row.sessionId !== sessionId) || (row.runId !== null && row.runId !== runId))
        throw new CreationError("conflict");
      this.db
        .query("UPDATE creation_tasks SET sessionId=?,runId=?,updatedAt=? WHERE id=?")
        .run(sessionId, runId, now, row.id);
      return { ...lease, sessionId, runId };
    });
  }
  heartbeat(lease: CreationLease, now: number, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) throw new CreationError("invalidInput");
    return this.transaction(() => {
      const row = this.active(lease, now);
      this.db.query("UPDATE creation_tasks SET leaseUntil=?,updatedAt=? WHERE id=?").run(now + leaseMs, now, row.id);
    });
  }
  assertExecution(scope: CreationExecution, now: number) {
    const row = this.active(scope, now);
    if (!row.sessionId || !row.runId || row.sessionId !== scope.sessionId || row.runId !== scope.runId)
      throw new CreationError("leaseLost");
    return creationTask(row);
  }
  admit(scope: CreationExecution, digest: string, now: number) {
    creationDigest(digest);
    return this.transaction(() => {
      const task = this.assertExecution(scope, now);
      if (task.outputDigest) return task;
      const context = this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM creation_messages WHERE taskId=? ORDER BY createdAt DESC,id DESC LIMIT 1",
        )
        .get(scope.taskId);
      if (context && context.id !== scope.contextVersion) throw new CreationError("conflict");
      const goal = this.db
        .query<{ event: string }, [string, string]>("SELECT event FROM creation_goals WHERE owner=? AND id=?")
        .get(scope.owner, scope.taskId);
      if (goal && JSON.parse(goal.event).at !== scope.goalVersion) throw new CreationError("conflict");
      if (this.db.query("SELECT 1 FROM creation_questions WHERE taskId=? AND state='pending'").get(scope.taskId))
        throw new CreationError("conflict");
      this.db
        .query("UPDATE creation_tasks SET state='committing',outputDigest=?,updatedAt=? WHERE id=?")
        .run(digest, now, scope.taskId);
      return this.get(scope.owner, scope.taskId);
    });
  }
  cancel(owner: string, id: string, now: number) {
    creationInteger(now);
    return this.transaction(() => {
      const row = this.row(owner, id);
      if (["succeeded", "failed", "cancelled"].includes(row.state)) return creationTask(row);
      this.db.query("UPDATE creation_questions SET state='expired' WHERE taskId=? AND state='pending'").run(id);
      this.db
        .query(
          "UPDATE creation_tasks SET cancelRequested=1,state=CASE WHEN outputDigest IS NULL THEN 'cancelled' ELSE 'committing' END,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",
        )
        .run(now, id);
      return this.get(owner, id);
    });
  }
  complete(owner: string, id: string, digest: string, artifact: CreationArtifact, now: number) {
    creationInteger(now);
    return this.transaction(() => {
      const row = this.row(owner, id),
        checked = creationArtifact(artifact, creationTask(row).spec);
      if (row.outputDigest !== digest) throw new CreationError("conflict");
      if (row.artifact !== null) {
        if (stableJson(checked) !== stableJson(JSON.parse(row.artifact))) throw new CreationError("conflict");
        return creationTask(row);
      }
      if (row.state !== "committing") throw new CreationError("conflict");
      this.db
        .query(
          "UPDATE creation_tasks SET state=CASE WHEN cancelRequested=1 THEN 'cancelled' ELSE 'succeeded' END,artifact=?,failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",
        )
        .run(stableJson(checked), now, id);
      return this.get(owner, id);
    });
  }
  outputFailure(owner: string, id: string, digest: string, failure: CreationFailure, now: number) {
    creationInteger(now);
    this.db
      .query(
        "UPDATE creation_tasks SET failure=?,updatedAt=? WHERE owner=? AND id=? AND outputDigest=? AND state='committing' AND artifact IS NULL",
      )
      .run(failure, now, owner, id, digest);
  }
  pending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new CreationError("invalidInput");
    return this.db
      .query<CreationTaskRow, [number]>(
        "SELECT * FROM creation_tasks WHERE state='committing' ORDER BY updatedAt,id LIMIT ?",
      )
      .all(limit)
      .map(creationTask);
  }
}
