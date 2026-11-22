import { randomUUID } from "node:crypto";
import { CreationError, type CreationExecution, type CreationFailure, type CreationLease } from "../contracts.js";
import type { CreationGoalStore } from "../goals/contracts.js";
import { creationDigest, creationInteger, creationText } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import { mysqlCreationTaskRow } from "./mysql-rows.js";
import type { MySQLCreationTasks } from "./mysql-tasks.js";
import { creationTask, type CreationTaskRow } from "./records.js";
import { MySQLCreationProgress } from "./mysql-progress.js";
import { creationReplyProgress } from "./progress.js";

/** Leases operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationLeases {
  constructor(
    private readonly context: MySQLCreationContext,
    private readonly tasks: MySQLCreationTasks,
    private readonly goalStore: () => CreationGoalStore,
  ) {}
  leaseMs(value: number) {
    if (!Number.isSafeInteger(value) || value < 1000 || value > 120000) throw new CreationError("invalidInput");
  }
  async claim(owner: string, id: string, now: number, leaseMs: number): Promise<CreationLease> {
    creationInteger(now);
    this.leaseMs(leaseMs);
    return this.context.transaction(async () => {
      const row = await this.tasks.row(owner, id);
      if (row.cancelRequested || !(row.state === "queued" || (row.state === "running" && (row.leaseUntil ?? 0) <= now)))
        throw new CreationError("conflict");
      if (row.budget <= 0) throw new CreationError("unavailable");
      if (await this.tasks.hasPending(id)) throw new CreationError("conflict");
      const token = randomUUID(),
        generation = row.generation + 1;
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state='running',generation=${generation},attempts=attempts+1,budget=budget-1,token=${token},leaseUntil=${now + leaseMs},sessionId=NULL,runId=NULL,failure=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
      return { taskId: row.id, owner: row.owner, generation, token };
    });
  }
  async active(lease: CreationLease, now: number) {
    creationInteger(now);
    const row = await this.tasks.row(lease.owner, lease.taskId);
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
  async bind(lease: CreationLease, sessionId: string, runId: string, now: number) {
    sessionId = creationText(sessionId, 128);
    runId = creationText(runId, 128);
    return this.context.transaction(async () => {
      const row = await this.active(lease, now);
      if ((row.sessionId !== null && row.sessionId !== sessionId) || (row.runId !== null && row.runId !== runId))
        throw new CreationError("conflict");
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET sessionId=${sessionId},runId=${runId},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
      return { ...lease, sessionId, runId };
    });
  }
  async heartbeat(lease: CreationLease, now: number, leaseMs: number) {
    this.leaseMs(leaseMs);
    await this.context.transaction(async () => {
      const row = await this.active(lease, now);
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET leaseUntil=${now + leaseMs},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
    });
  }
  async assertExecution(scope: CreationExecution, now: number) {
    const row = await this.active(scope, now);
    if (!row.sessionId || !row.runId || row.sessionId !== scope.sessionId || row.runId !== scope.runId)
      throw new CreationError("leaseLost");
    return creationTask(row);
  }
  async admit(scope: CreationExecution, digest: string, now: number) {
    creationDigest(digest);
    return this.context.transaction(async () => {
      const task = await this.assertExecution(scope, now);
      if (task.outputDigest) return task;
      const [context] = await this.context
        .sql`SELECT id FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND taskId=${scope.taskId} ORDER BY createdAt DESC,id DESC LIMIT 1`;
      if (context && context.id !== scope.contextVersion) throw new CreationError("conflict");
      const goal = await this.goalStore().read(scope.owner, scope.taskId);
      if (goal && goal.at !== scope.goalVersion) throw new CreationError("conflict");
      if (await this.tasks.hasPending(scope.taskId)) throw new CreationError("conflict");
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state='committing',outputDigest=${digest},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${scope.taskId}`;
      return this.tasks.get(scope.owner, scope.taskId);
    });
  }
  async claimNext(now: number, leaseMs = 30000) {
    creationInteger(now);
    this.leaseMs(leaseMs);
    return this.context.transaction(async () => {
      await this.context
        .sql`UPDATE panda_force_creation_tasks t SET state='failed',failure='interrupted',token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND state='running' AND leaseUntil<=${now} AND budget<=0 AND outputDigest IS NULL AND NOT EXISTS(SELECT 1 FROM panda_force_creation_questions q WHERE q.namespace=t.namespace AND q.taskId=t.id AND q.state='pending')`;
      const rows = await this.context
        .sql`SELECT * FROM panda_force_creation_tasks t WHERE namespace=${this.context.namespace} AND outputDigest IS NULL AND cancelRequested=0 AND budget>0 AND (state='queued' OR (state='running' AND leaseUntil<=${now})) AND NOT EXISTS(SELECT 1 FROM panda_force_creation_questions q WHERE q.namespace=t.namespace AND q.taskId=t.id AND q.state='pending') ORDER BY createdAt,id LIMIT 1`;
      if (!rows.length) return null;
      const row = mysqlCreationTaskRow(rows[0]),
        lease = await this.claim(row.owner, row.id, now, leaseMs);
      return { lease, task: await this.tasks.get(row.owner, row.id) };
    });
  }
  matches(row: CreationTaskRow, lease: CreationLease) {
    return (
      row.state === "running" &&
      row.token === lease.token &&
      row.generation === lease.generation &&
      row.outputDigest === null
    );
  }
  async release(lease: CreationLease, now: number) {
    creationInteger(now);
    return this.context.transaction(async () => {
      const row = await this.tasks.row(lease.owner, lease.taskId);
      if (!this.matches(row, lease)) return false;
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state='queued',token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
      return true;
    });
  }
  async fail(lease: CreationLease, failure: CreationFailure, now: number) {
    creationInteger(now);
    return this.context.transaction(async () => {
      const row = await this.tasks.row(lease.owner, lease.taskId);
      if (!this.matches(row, lease)) return false;
      await this.tasks.expire(row.id);
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state='failed',failure=${failure},token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
      return true;
    });
  }
  async reply(lease: CreationLease, text: string, now: number) {
    return this.context.transaction(async () => {
      const row = await this.tasks.row(lease.owner, lease.taskId),
        namespace = this.context.namespace;
      if (!this.matches(row, lease) || row.cancelRequested || (row.leaseUntil ?? 0) <= now) return false;
      const pending = await this.context
        .sql`SELECT 1 FROM panda_force_creation_messages WHERE namespace=${namespace} AND taskId=${row.id} AND state<>'delivered' LIMIT 1`;
      if (pending.length || (await this.tasks.hasPending(row.id))) return false;
      await new MySQLCreationProgress(this.context, this.tasks).progress.record(
        lease,
        creationReplyProgress(lease, text, now),
      );
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state='replied',failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${namespace} AND id=${row.id}`;
      return true;
    });
  }
}
