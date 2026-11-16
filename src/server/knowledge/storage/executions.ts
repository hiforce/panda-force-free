import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { KNOWLEDGE_LIMITS, type KnowledgeFailure } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeExecutionTasks,
  type KnowledgeExecution,
  type KnowledgeLease,
  type KnowledgeTaskRow,
  type KnowledgeTaskReads,
} from "../tasks/contracts.js";
import { type StoredTask } from "./records.js";
import { generationBudgetFailure } from "./generation-budget.js";

/** Owns executions metadata transitions on the application's one transactional connection. */
export class KnowledgeTaskExecutions implements KnowledgeExecutionTasks {
  constructor(
    private readonly db: Database,
    private readonly reads: Pick<KnowledgeTaskReads, "get">,
  ) {}
  claim(now: number, leaseMs: number): { task: KnowledgeTaskRow; lease: KnowledgeLease } | null {
    return this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE knowledge_tasks SET failures=failures+1,state=CASE WHEN failures+1>=? OR attempts>=? THEN 'failed' ELSE 'queued' END,failure=CASE WHEN failures+1>=? OR attempts>=? THEN 'budget' ELSE NULL END,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE state='running' AND leaseUntil<=?",
          )
          .run(
            KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts,
            now,
            now,
          );
        const found = this.db
          .query<StoredTask, [number, number, number]>(
            `SELECT task.* FROM knowledge_tasks task
        WHERE (task.state='queued' OR (task.state='running' AND task.leaseUntil<=?)) AND task.attempts<? AND task.failures<3
        AND NOT EXISTS (SELECT 1 FROM knowledge_tasks other WHERE other.owner=task.owner AND other.state='running' AND other.leaseUntil>? AND other.id!=task.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_reviews other WHERE other.owner=task.owner AND other.state='running')
        ORDER BY task.createdAt,task.id LIMIT 1`,
          )
          .get(now, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts, now);
        if (!found) return null;
        const token = randomUUID();
        this.db
          .query(
            "UPDATE knowledge_tasks SET state='running',generation=generation+1,attempts=attempts+1,token=?,leaseUntil=?,sessionId=NULL,runId=NULL,failure=NULL,updatedAt=? WHERE id=?",
          )
          .run(token, now + leaseMs, now, found.id);
        const task = this.reads.get(found.owner, found.id);
        return { task, lease: { owner: task.owner, taskId: task.id, generation: task.generation, token } };
      })
      .immediate();
  }

  assertLease(lease: KnowledgeLease, now: number): KnowledgeTaskRow {
    const task = this.reads.get(lease.owner, lease.taskId);
    if (
      task.state !== "running" ||
      task.generation !== lease.generation ||
      task.token !== lease.token ||
      task.leaseUntil! <= now
    )
      throw new KnowledgeTaskError("leaseLost");
    return task;
  }

  assertExecution(scope: KnowledgeExecution, now: number) {
    const task = this.assertLease(scope, now);
    if (task.sessionId !== scope.sessionId || task.runId !== scope.runId) throw new KnowledgeTaskError("leaseLost");
    return task;
  }

  bind(lease: KnowledgeLease, scope: { sessionId: string; runId: string }, now: number): KnowledgeExecution {
    if (
      [scope.sessionId, scope.runId].some((id) => typeof id !== "string" || !id || id.length > 128 || id.includes("\0"))
    )
      throw new KnowledgeTaskError("invalidInput");
    return this.db
      .transaction(() => {
        const task = this.assertLease(lease, now);
        if (task.sessionId !== null && (task.sessionId !== scope.sessionId || task.runId !== scope.runId))
          throw new KnowledgeTaskError("leaseLost");
        this.db
          .query("UPDATE knowledge_tasks SET sessionId=?,runId=?,updatedAt=? WHERE id=?")
          .run(scope.sessionId, scope.runId, now, task.id);
        return { ...lease, ...scope };
      })
      .immediate();
  }

  heartbeat(lease: KnowledgeLease, now: number, leaseMs: number) {
    return this.db
      .transaction(() => {
        this.assertLease(lease, now);
        this.db.query("UPDATE knowledge_tasks SET leaseUntil=? WHERE id=?").run(now + leaseMs, lease.taskId);
      })
      .immediate();
  }

  fail(lease: KnowledgeLease, failure: KnowledgeFailure, now: number) {
    const changed = this.db
      .query(
        "UPDATE knowledge_tasks SET state=?,failure=?,failures=failures+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE owner=? AND id=? AND state='running' AND generation=? AND token=? AND leaseUntil>?",
      )
      .run(
        failure === "sourceChanged" ? "stale" : "failed",
        failure,
        now,
        lease.owner,
        lease.taskId,
        lease.generation,
        lease.token,
        now,
      );
    return changed.changes > 0;
  }

  release(lease: KnowledgeLease, now: number) {
    this.db
      .query(
        "UPDATE knowledge_tasks SET leaseUntil=? WHERE owner=? AND id=? AND state='running' AND generation=? AND token=?",
      )
      .run(now, lease.owner, lease.taskId, lease.generation, lease.token);
  }

  retry(owner: string, id: string, now: number) {
    try {
      return this.db
        .transaction(() => {
          const pending = this.db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) count FROM knowledge_tasks WHERE owner=? AND state IN ('queued','running','waiting','review','committing')",
            )
            .get(owner)!.count;
          if (pending >= KNOWLEDGE_LIMITS.pendingPerOwner) throw new KnowledgeTaskError("budget");
          const changed = this.db
            .query(
              "UPDATE knowledge_tasks SET state='queued',generation=generation+1,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='failed' AND attempts<? AND failures<3",
            )
            .run(now, owner, id, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts);
          if (!changed.changes) throw new KnowledgeTaskError("conflict");
          this.db.query("UPDATE knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?").run(id, owner);
          return this.reads.get(owner, id);
        })
        .immediate();
    } catch (error) {
      if (generationBudgetFailure(error)) throw new KnowledgeTaskError("budget");
      throw error;
    }
  }
}
