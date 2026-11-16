import type { Database } from "bun:sqlite";
import type { CreationLease, CreationFailure } from "../contracts.js";
import { CreationError } from "../contracts.js";
import { creationId, creationInteger, creationUuid } from "../validation.js";
import type { CreationTaskRepository } from "./repository.js";
import { readCreationTask, creationTask, creationSignature, type CreationTaskRow } from "./records.js";

/** Scheduling and explicit user actions share short metadata transactions, never a model process or a Git write. */
export class CreationQueue {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<CreationTaskRepository, "get" | "claim">,
  ) {}
  claim(now: number, leaseMs = 30000) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        this.db
          .query(
            `UPDATE creation_tasks SET state='failed',failure='interrupted',token=NULL,leaseUntil=NULL,updatedAt=?
        WHERE state='running' AND leaseUntil<=? AND budget<=0 AND outputDigest IS NULL
        AND NOT EXISTS(SELECT 1 FROM creation_questions WHERE taskId=creation_tasks.id AND state='pending')`,
          )
          .run(now, now);
        const row = this.db
          .query<CreationTaskRow, [number]>(
            `SELECT * FROM creation_tasks WHERE outputDigest IS NULL AND cancelRequested=0 AND budget>0
        AND (state='queued' OR (state='running' AND leaseUntil<=?))
        AND NOT EXISTS(SELECT 1 FROM creation_questions WHERE taskId=creation_tasks.id AND state='pending')
        ORDER BY createdAt,id LIMIT 1`,
          )
          .get(now);
        if (!row) return null;
        const lease = this.tasks.claim(row.owner, row.id, now, leaseMs);
        return { lease, task: this.tasks.get(row.owner, row.id) };
      })
      .immediate();
  }
  private matches(row: CreationTaskRow, lease: CreationLease) {
    return (
      row.state === "running" &&
      row.token === lease.token &&
      row.generation === lease.generation &&
      row.outputDigest === null
    );
  }
  release(lease: CreationLease, now: number) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, lease.owner, lease.taskId);
        if (!this.matches(row, lease)) return false;
        // Keep unanswered questions available while no engine process is attached.
        this.db
          .query(
            "UPDATE creation_tasks SET state='queued',token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          )
          .run(now, row.id);
        return true;
      })
      .immediate();
  }
  fail(lease: CreationLease, failure: CreationFailure, now: number) {
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, lease.owner, lease.taskId);
        if (!this.matches(row, lease)) return false;
        this.db.query("UPDATE creation_questions SET state='expired' WHERE taskId=? AND state='pending'").run(row.id);
        this.db
          .query("UPDATE creation_tasks SET state='failed',failure=?,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?")
          .run(failure, now, row.id);
        return true;
      })
      .immediate();
  }
  retry(owner: string, id: string, operationId: string, now: number) {
    creationUuid(operationId);
    creationInteger(now);
    return this.db
      .transaction(() => {
        const row = readCreationTask(this.db, owner, id),
          request = creationSignature({ action: "retry", taskId: id }),
          prior = this.db
            .query<{ owner: string; request: string }, [string]>(
              "SELECT owner,request FROM creation_actions WHERE id=?",
            )
            .get(operationId);
        if (prior) {
          if (prior.owner !== owner) throw new CreationError("notFound");
          if (prior.request !== request) throw new CreationError("conflict");
          return creationTask(row);
        }
        if (
          row.artifact !== null ||
          !(row.state === "failed" || row.state === "cancelled" || (row.state === "committing" && row.failure !== null))
        )
          throw new CreationError("conflict");
        if (row.outputDigest === null) {
          const active = this.db
            .query<{ own: number; total: number }, [string]>(
              "SELECT COALESCE(SUM(owner=?),0) AS own,COUNT(*) AS total FROM creation_tasks WHERE state IN('queued','running','committing')",
            )
            .get(owner)!;
          if (active.own >= 32 || active.total >= 256) throw new CreationError("unavailable");
          this.db
            .query(
              "UPDATE creation_tasks SET state='queued',budget=3,cancelRequested=0,failure=NULL,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
            )
            .run(now, id);
        } else this.db.query("UPDATE creation_tasks SET failure=NULL,updatedAt=? WHERE id=?").run(now, id);
        this.db
          .query("INSERT INTO creation_actions(id,owner,taskId,request,createdAt) VALUES(?,?,?,?,?)")
          .run(operationId, owner, id, request, now);
        return this.tasks.get(owner, id);
      })
      .immediate();
  }
  list(owner: string, projectId: string) {
    creationId(projectId);
    return this.db
      .query<CreationTaskRow, [string, string]>(
        "SELECT * FROM creation_tasks WHERE owner=? AND projectId=? ORDER BY createdAt DESC,id DESC LIMIT 50",
      )
      .all(owner, projectId)
      .map(creationTask);
  }
  nextOutput(now: number) {
    creationInteger(now);
    const row = this.db
      .query<CreationTaskRow, [number]>(
        `SELECT * FROM creation_tasks WHERE state='committing' AND artifact IS NULL
      AND (failure IS NULL OR (failure='writeUnavailable' AND updatedAt<=?)) ORDER BY updatedAt,id LIMIT 1`,
      )
      .get(now - 5000);
    return row ? creationTask(row) : null;
  }
}
