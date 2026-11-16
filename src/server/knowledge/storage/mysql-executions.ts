import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { randomUUID } from "node:crypto";
import { KNOWLEDGE_LIMITS, type KnowledgeFailure } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeExecution,
  type KnowledgeLease,
  type KnowledgeTaskRow,
  type KnowledgeTaskReads,
} from "../tasks/contracts.js";
import { type StoredTask } from "./mysql-records.js";
import { generationBudgetFailure } from "./mysql-generation-budget.js";
/** Owns executions metadata transitions on the application's one transactional connection. */
export class MySQLKnowledgeTaskExecutions {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly reads: Pick<AsyncMetadataStore<KnowledgeTaskReads>, "get">,
  ) {}
  async claim(
    now: number,
    leaseMs: number,
  ): Promise<{
    task: KnowledgeTaskRow;
    lease: KnowledgeLease;
  } | null> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state=CASE WHEN failures+1>=? OR attempts>=? THEN 'failed' ELSE 'queued' END,failure=CASE WHEN failures+1>=? OR attempts>=? THEN 'budget' ELSE NULL END,failures=failures+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE state='running' AND leaseUntil<=?",
          [
            KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.attempts,
            KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts,
            now,
            now,
          ],
        );
        const found = await this.db.one<StoredTask>(
          `SELECT task.* FROM panda_force_knowledge_tasks task
        WHERE (task.state='queued' OR (task.state='running' AND task.leaseUntil<=?)) AND task.attempts<? AND task.failures<3
        AND NOT EXISTS (SELECT 1 FROM panda_force_knowledge_tasks other WHERE other.owner=task.owner AND other.state='running' AND other.leaseUntil>? AND other.id!=task.id)
        AND NOT EXISTS (SELECT 1 FROM panda_force_knowledge_reviews other WHERE other.owner=task.owner AND other.state='running')
        ORDER BY task.createdAt,task.id LIMIT 1`,
          [now, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts, now],
        );
        if (!found) return null;
        const token = randomUUID();
        await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='running',generation=generation+1,attempts=attempts+1,token=?,leaseUntil=?,sessionId=NULL,runId=NULL,failure=NULL,updatedAt=? WHERE id=?",
          [token, now + leaseMs, now, found.id],
        );
        const task = await this.reads.get(found.owner, found.id);
        return { task, lease: { owner: task.owner, taskId: task.id, generation: task.generation, token } };
      });
    });
  }
  async assertLease(lease: KnowledgeLease, now: number): Promise<KnowledgeTaskRow> {
    return await this.db.atomic(async () => {
      const task = await this.reads.get(lease.owner, lease.taskId);
      if (
        task.state !== "running" ||
        task.generation !== lease.generation ||
        task.token !== lease.token ||
        task.leaseUntil! <= now
      )
        throw new KnowledgeTaskError("leaseLost");
      return task;
    });
  }
  async assertExecution(scope: KnowledgeExecution, now: number) {
    return await this.db.atomic(async () => {
      const task = await this.assertLease(scope, now);
      if (task.sessionId !== scope.sessionId || task.runId !== scope.runId) throw new KnowledgeTaskError("leaseLost");
      return task;
    });
  }
  async bind(
    lease: KnowledgeLease,
    scope: {
      sessionId: string;
      runId: string;
    },
    now: number,
  ): Promise<KnowledgeExecution> {
    return await this.db.atomic(async () => {
      if (
        [scope.sessionId, scope.runId].some(
          (id) => typeof id !== "string" || !id || id.length > 128 || id.includes("\0"),
        )
      )
        throw new KnowledgeTaskError("invalidInput");
      return await this.db.atomic(async () => {
        const task = await this.assertLease(lease, now);
        if (task.sessionId !== null && (task.sessionId !== scope.sessionId || task.runId !== scope.runId))
          throw new KnowledgeTaskError("leaseLost");
        await this.db.execute("UPDATE panda_force_knowledge_tasks SET sessionId=?,runId=?,updatedAt=? WHERE id=?", [
          scope.sessionId,
          scope.runId,
          now,
          task.id,
        ]);
        return { ...lease, ...scope };
      });
    });
  }
  async heartbeat(lease: KnowledgeLease, now: number, leaseMs: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.assertLease(lease, now);
        await this.db.execute("UPDATE panda_force_knowledge_tasks SET leaseUntil=? WHERE id=?", [
          now + leaseMs,
          lease.taskId,
        ]);
      });
    });
  }
  async fail(lease: KnowledgeLease, failure: KnowledgeFailure, now: number) {
    return await this.db.atomic(async () => {
      const changed = await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET state=?,failure=?,failures=failures+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE owner=? AND id=? AND state='running' AND generation=? AND token=? AND leaseUntil>?",
        [
          failure === "sourceChanged" ? "stale" : "failed",
          failure,
          now,
          lease.owner,
          lease.taskId,
          lease.generation,
          lease.token,
          now,
        ],
      );
      return changed.changes > 0;
    });
  }
  async release(lease: KnowledgeLease, now: number) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET leaseUntil=? WHERE owner=? AND id=? AND state='running' AND generation=? AND token=?",
        [now, lease.owner, lease.taskId, lease.generation, lease.token],
      );
    });
  }
  async retry(owner: string, id: string, now: number) {
    return await this.db.atomic(async () => {
      try {
        return await this.db.atomic(async () => {
          const pending = (await this.db.one<{
            count: number;
          }>(
            "SELECT COUNT(*) count FROM panda_force_knowledge_tasks WHERE owner=? AND state IN ('queued','running','waiting','review','committing')",
            [owner],
          ))!.count;
          if (pending >= KNOWLEDGE_LIMITS.pendingPerOwner) throw new KnowledgeTaskError("budget");
          const changed = await this.db.execute(
            "UPDATE panda_force_knowledge_tasks SET state='queued',generation=generation+1,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='failed' AND attempts<? AND failures<3",
            [now, owner, id, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts],
          );
          if (!changed.changes) throw new KnowledgeTaskError("conflict");
          await this.db.execute(
            "UPDATE panda_force_knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?",
            [id, owner],
          );
          return await this.reads.get(owner, id);
        });
      } catch (error) {
        if (generationBudgetFailure(error)) throw new KnowledgeTaskError("budget");
        throw error;
      }
    });
  }
}
