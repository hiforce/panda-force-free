import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { consistentMySQLRead } from "../../database/consistent-read.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import {
  CreationError,
  type CreationArtifact,
  type CreationExecution,
  type CreationFailure,
  type CreationLease,
} from "../contracts.js";
import type { CreationQuestionRecord } from "../questions/contracts.js";
import {
  creationArtifact,
  creationDigest,
  creationId,
  creationInteger,
  creationTaskSpec,
  creationText,
  creationUuid,
  creationUuidFromDigest,
} from "../validation.js";
import { creationSignature, creationTask, type CreationTaskRow } from "./records.js";

export function creationLedgerNamespace(value: string) {
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))
    throw new CreationError("invalidInput");
  return value;
}
const integers = [
  "generation",
  "attempts",
  "budget",
  "leaseUntil",
  "cancelRequested",
  "createdAt",
  "updatedAt",
  "answeredAt",
];
function numbers<T>(row: T): T {
  const result = { ...row };
  for (const key of integers)
    if (Object.hasOwn(result as object, key) && (result as any)[key] !== null)
      (result as any)[key] = mysqlInteger((result as any)[key]);
  delete (result as any).namespace;
  delete (result as any).pendingTaskId;
  return result;
}
/** All ledger writers lock one durable namespace row. No model, file or Git work enters the transaction. */
export class MySQLCreationLedger {
  private readonly context = new AsyncLocalStorage<SQL>();
  readonly namespace: string;
  constructor(
    private readonly pool: SQL,
    namespace: string,
  ) {
    this.namespace = creationLedgerNamespace(namespace);
  }
  private get sql() {
    return this.context.getStore() ?? this.pool;
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.pool.begin(async (sql) => {
      await sql`INSERT INTO panda_force_creation_ledgers(namespace) VALUES(${this.namespace}) ON DUPLICATE KEY UPDATE namespace=VALUES(namespace)`;
      await sql`SELECT namespace FROM panda_force_creation_ledgers WHERE namespace=${this.namespace} FOR UPDATE`;
      return this.context.run(sql, work);
    });
  }
  private async read<T>(work: () => Promise<T>) {
    if (this.context.getStore()) return work();
    return consistentMySQLRead(this.pool, (sql) => this.context.run(sql, work));
  }
  private async row(owner: string, id: string): Promise<CreationTaskRow> {
    const rows = await this
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND owner=${creationText(owner)} AND id=${creationUuid(id)}`;
    if (!rows.length) throw new CreationError("notFound");
    const row = numbers(rows[0] as CreationTaskRow);
    creationTask(row);
    return row;
  }
  async get(owner: string, id: string) {
    return creationTask(await this.row(owner, id));
  }
  async find(owner: string, id: string) {
    const rows = await this
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND id=${creationUuid(id)}`;
    if (!rows.length) return null;
    if (rows[0].owner !== creationText(owner)) throw new CreationError("notFound");
    return creationTask(numbers(rows[0] as CreationTaskRow));
  }
  private async capacity(owner: string) {
    const [active] = await this
      .sql`SELECT COALESCE(SUM(owner=${owner}),0) AS own,COUNT(*) AS total FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND state IN ('queued','running','committing')`;
    if (mysqlInteger(active.own) >= 32 || mysqlInteger(active.total) >= 256) throw new CreationError("unavailable");
  }
  async create(value: unknown, now: number) {
    const spec = creationTaskSpec(value),
      signature = creationSignature(spec);
    creationInteger(now);
    return this.transaction(async () => {
      const prior = await this.find(spec.owner, spec.id);
      if (prior) {
        if (creationSignature(prior.spec) !== signature) throw new CreationError("conflict");
        return prior;
      }
      await this.capacity(spec.owner);
      if (
        (
          await this
            .sql`SELECT 1 FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND operationId=${spec.operationId}`
        ).length
      )
        throw new CreationError("conflict");
      await this
        .sql`INSERT INTO panda_force_creation_tasks(namespace,id,owner,projectId,operationId,spec,signature,state,createdAt,updatedAt) VALUES(${this.namespace},${spec.id},${spec.owner},${spec.projectId},${spec.operationId},${stableJson(spec)},${signature},'queued',${now},${now})`;
      return this.get(spec.owner, spec.id);
    });
  }
  private leaseMs(value: number) {
    if (!Number.isSafeInteger(value) || value < 1000 || value > 120000) throw new CreationError("invalidInput");
  }
  private async hasPending(id: string) {
    return (
      (
        await this
          .sql`SELECT 1 FROM panda_force_creation_questions WHERE namespace=${this.namespace} AND taskId=${id} AND state='pending'`
      ).length > 0
    );
  }
  async claim(owner: string, id: string, now: number, leaseMs: number): Promise<CreationLease> {
    creationInteger(now);
    this.leaseMs(leaseMs);
    return this.transaction(async () => {
      const row = await this.row(owner, id);
      if (row.cancelRequested || !(row.state === "queued" || (row.state === "running" && (row.leaseUntil ?? 0) <= now)))
        throw new CreationError("conflict");
      if (row.budget <= 0) throw new CreationError("unavailable");
      if (await this.hasPending(id)) throw new CreationError("conflict");
      const token = randomUUID(),
        generation = row.generation + 1;
      await this
        .sql`UPDATE panda_force_creation_tasks SET state='running',generation=${generation},attempts=attempts+1,budget=budget-1,token=${token},leaseUntil=${now + leaseMs},sessionId=NULL,runId=NULL,failure=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${row.id}`;
      return { taskId: row.id, owner: row.owner, generation, token };
    });
  }
  private async active(lease: CreationLease, now: number) {
    creationInteger(now);
    const row = await this.row(lease.owner, lease.taskId);
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
    return this.transaction(async () => {
      const row = await this.active(lease, now);
      if ((row.sessionId !== null && row.sessionId !== sessionId) || (row.runId !== null && row.runId !== runId))
        throw new CreationError("conflict");
      await this
        .sql`UPDATE panda_force_creation_tasks SET sessionId=${sessionId},runId=${runId},updatedAt=${now} WHERE namespace=${this.namespace} AND id=${row.id}`;
      return { ...lease, sessionId, runId };
    });
  }
  async heartbeat(lease: CreationLease, now: number, leaseMs: number) {
    this.leaseMs(leaseMs);
    await this.transaction(async () => {
      const row = await this.active(lease, now);
      await this
        .sql`UPDATE panda_force_creation_tasks SET leaseUntil=${now + leaseMs},updatedAt=${now} WHERE namespace=${this.namespace} AND id=${row.id}`;
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
    return this.transaction(async () => {
      const task = await this.assertExecution(scope, now);
      if (task.outputDigest) return task;
      if (await this.hasPending(scope.taskId)) throw new CreationError("conflict");
      await this
        .sql`UPDATE panda_force_creation_tasks SET state='committing',outputDigest=${digest},updatedAt=${now} WHERE namespace=${this.namespace} AND id=${scope.taskId}`;
      return this.get(scope.owner, scope.taskId);
    });
  }
  private async expire(id: string) {
    await this
      .sql`UPDATE panda_force_creation_questions SET state='expired',pendingTaskId=NULL WHERE namespace=${this.namespace} AND taskId=${id} AND state='pending'`;
  }
  async cancel(owner: string, id: string, now: number) {
    creationInteger(now);
    return this.transaction(async () => {
      const row = await this.row(owner, id);
      if (["succeeded", "failed", "cancelled"].includes(row.state)) return creationTask(row);
      await this.expire(id);
      await this
        .sql`UPDATE panda_force_creation_tasks SET cancelRequested=1,state=CASE WHEN outputDigest IS NULL THEN 'cancelled' ELSE 'committing' END,token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${id}`;
      return this.get(owner, id);
    });
  }
  async complete(owner: string, id: string, digest: string, artifact: CreationArtifact, now: number) {
    creationInteger(now);
    return this.transaction(async () => {
      const row = await this.row(owner, id),
        checked = creationArtifact(artifact, creationTask(row).spec);
      if (row.outputDigest !== digest) throw new CreationError("conflict");
      if (row.artifact !== null) {
        if (stableJson(checked) !== stableJson(JSON.parse(row.artifact))) throw new CreationError("conflict");
        return creationTask(row);
      }
      if (row.state !== "committing") throw new CreationError("conflict");
      await this
        .sql`UPDATE panda_force_creation_tasks SET state=CASE WHEN cancelRequested=1 THEN 'cancelled' ELSE 'succeeded' END,artifact=${stableJson(checked)},failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${id}`;
      return this.get(owner, id);
    });
  }
  async outputFailure(owner: string, id: string, digest: string, failure: CreationFailure, now: number) {
    creationInteger(now);
    await this.transaction(async () => {
      await this
        .sql`UPDATE panda_force_creation_tasks SET failure=${failure},updatedAt=${now} WHERE namespace=${this.namespace} AND owner=${owner} AND id=${id} AND outputDigest=${digest} AND state='committing' AND artifact IS NULL`;
    });
  }
  async pending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new CreationError("invalidInput");
    return (
      await this
        .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND state='committing' ORDER BY updatedAt,id LIMIT ${limit}`
    ).map((r: any) => creationTask(numbers(r as CreationTaskRow)));
  }
  async claimNext(now: number, leaseMs = 30000) {
    creationInteger(now);
    this.leaseMs(leaseMs);
    return this.transaction(async () => {
      await this
        .sql`UPDATE panda_force_creation_tasks t SET state='failed',failure='interrupted',token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND state='running' AND leaseUntil<=${now} AND budget<=0 AND outputDigest IS NULL AND NOT EXISTS(SELECT 1 FROM panda_force_creation_questions q WHERE q.namespace=t.namespace AND q.taskId=t.id AND q.state='pending')`;
      const rows = await this
        .sql`SELECT * FROM panda_force_creation_tasks t WHERE namespace=${this.namespace} AND outputDigest IS NULL AND cancelRequested=0 AND budget>0 AND (state='queued' OR (state='running' AND leaseUntil<=${now})) AND NOT EXISTS(SELECT 1 FROM panda_force_creation_questions q WHERE q.namespace=t.namespace AND q.taskId=t.id AND q.state='pending') ORDER BY createdAt,id LIMIT 1`;
      if (!rows.length) return null;
      const row = numbers(rows[0] as CreationTaskRow),
        lease = await this.claim(row.owner, row.id, now, leaseMs);
      return { lease, task: await this.get(row.owner, row.id) };
    });
  }
  private matches(row: CreationTaskRow, lease: CreationLease) {
    return (
      row.state === "running" &&
      row.token === lease.token &&
      row.generation === lease.generation &&
      row.outputDigest === null
    );
  }
  async release(lease: CreationLease, now: number) {
    creationInteger(now);
    return this.transaction(async () => {
      const row = await this.row(lease.owner, lease.taskId);
      if (!this.matches(row, lease)) return false;
      await this
        .sql`UPDATE panda_force_creation_tasks SET state='queued',token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${row.id}`;
      return true;
    });
  }
  async fail(lease: CreationLease, failure: CreationFailure, now: number) {
    creationInteger(now);
    return this.transaction(async () => {
      const row = await this.row(lease.owner, lease.taskId);
      if (!this.matches(row, lease)) return false;
      await this.expire(row.id);
      await this
        .sql`UPDATE panda_force_creation_tasks SET state='failed',failure=${failure},token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${row.id}`;
      return true;
    });
  }
  async retry(owner: string, id: string, operationId: string, now: number) {
    creationUuid(operationId);
    creationInteger(now);
    return this.transaction(async () => {
      const row = await this.row(owner, id),
        request = creationSignature({ action: "retry", taskId: id }),
        previous = await this
          .sql`SELECT owner,request FROM panda_force_creation_actions WHERE namespace=${this.namespace} AND id=${operationId}`;
      if (previous.length) {
        if (previous[0].owner !== owner) throw new CreationError("notFound");
        if (previous[0].request !== request) throw new CreationError("conflict");
        return creationTask(row);
      }
      if (
        row.artifact !== null ||
        !(row.state === "failed" || row.state === "cancelled" || (row.state === "committing" && row.failure !== null))
      )
        throw new CreationError("conflict");
      if (row.outputDigest === null) {
        await this.capacity(owner);
        await this
          .sql`UPDATE panda_force_creation_tasks SET state='queued',budget=3,cancelRequested=0,failure=NULL,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${id}`;
      } else
        await this
          .sql`UPDATE panda_force_creation_tasks SET failure=NULL,updatedAt=${now} WHERE namespace=${this.namespace} AND id=${id}`;
      await this
        .sql`INSERT INTO panda_force_creation_actions(namespace,id,owner,taskId,request,createdAt) VALUES(${this.namespace},${operationId},${owner},${id},${request},${now})`;
      return this.get(owner, id);
    });
  }
  async list(owner: string, projectId: string) {
    creationId(projectId);
    return (
      await this
        .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND owner=${owner} AND projectId=${projectId} ORDER BY createdAt DESC,id DESC LIMIT 50`
    ).map((r: any) => creationTask(numbers(r as CreationTaskRow)));
  }
  async nextOutput(now: number) {
    creationInteger(now);
    const rows = await this
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.namespace} AND state='committing' AND artifact IS NULL AND (failure IS NULL OR (failure='writeUnavailable' AND updatedAt<=${now - 5000})) ORDER BY updatedAt,id LIMIT 1`;
    return rows.length ? creationTask(numbers(rows[0] as CreationTaskRow)) : null;
  }
  task(owner: string, id: string) {
    return this.get(owner, id);
  }
  async assert(scope: CreationExecution, now: number) {
    await this.assertExecution(scope, now);
  }
  async question(owner: string, id: string): Promise<CreationQuestionRecord> {
    const rows = await this
      .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.namespace} AND owner=${owner} AND id=${creationUuid(id)}`;
    if (!rows.length) throw new CreationError("notFound");
    return numbers(rows[0] as CreationQuestionRecord);
  }
  async pendingQuestion(owner: string, taskId: string) {
    return this.read(async () => {
      await this.get(owner, taskId);
      const rows = await this
        .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.namespace} AND owner=${owner} AND taskId=${taskId} AND state='pending'`;
      return rows.length ? numbers(rows[0] as CreationQuestionRecord) : null;
    });
  }
  async register(scope: CreationExecution, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.transaction(async () => {
      const task = await this.assertExecution(scope, now),
        id = creationUuidFromDigest(
          creationSignature({
            namespace: "panda-creation-question",
            owner: scope.owner,
            taskId: scope.taskId,
            generation: scope.generation,
            digest,
          }),
        );
      if (task.outputDigest) throw new CreationError("conflict");
      const rows = await this
        .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.namespace} AND id=${id}`;
      if (rows.length) return numbers(rows[0] as CreationQuestionRecord);
      if (
        (await this.pendingQuestion(scope.owner, scope.taskId)) ||
        (await this.answered(scope.owner, scope.taskId)).length >= 16
      )
        throw new CreationError("conflict");
      await this
        .sql`INSERT INTO panda_force_creation_questions(namespace,id,taskId,owner,generation,questionDigest,state,createdAt,pendingTaskId) VALUES(${this.namespace},${id},${scope.taskId},${scope.owner},${scope.generation},${digest},'pending',${now},${scope.taskId})`;
      return this.question(scope.owner, id);
    });
  }
  async answer(owner: string, id: string, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.transaction(async () => {
      const question = await this.question(owner, id),
        task = await this.row(owner, question.taskId);
      if (question.state === "answered") {
        if (question.answerDigest !== digest) throw new CreationError("conflict");
        return question;
      }
      if (
        question.state !== "pending" ||
        task.cancelRequested ||
        task.outputDigest ||
        !["queued", "running"].includes(task.state) ||
        task.generation !== question.generation
      )
        throw new CreationError("conflict");
      await this
        .sql`UPDATE panda_force_creation_questions SET state='answered',answerDigest=${digest},answeredAt=${now},pendingTaskId=NULL WHERE namespace=${this.namespace} AND id=${id} AND state='pending'`;
      await this
        .sql`UPDATE panda_force_creation_tasks SET budget=GREATEST(1,budget) WHERE namespace=${this.namespace} AND id=${task.id}`;
      return this.question(owner, id);
    });
  }
  async answered(owner: string, taskId: string) {
    return this.read(async () => {
      await this.get(owner, taskId);
      return (
        await this
          .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.namespace} AND owner=${owner} AND taskId=${taskId} AND state='answered' ORDER BY createdAt,id LIMIT 16`
      ).map((r: any) => numbers(r as CreationQuestionRecord));
    });
  }
  get scheduling() {
    return {
      claim: this.claimNext.bind(this),
      release: this.release.bind(this),
      fail: this.fail.bind(this),
      nextOutput: this.nextOutput.bind(this),
      retry: this.retry.bind(this),
      list: this.list.bind(this),
    };
  }
  get questions() {
    return {
      task: this.task.bind(this),
      assert: this.assert.bind(this),
      register: this.register.bind(this),
      get: this.question.bind(this),
      pending: this.pendingQuestion.bind(this),
      answer: this.answer.bind(this),
      answered: this.answered.bind(this),
    };
  }
}

/** Matches PersonalContent's existing directory key, including empty personal ledgers. */
export function personalCreationLedgerNamespace(owner: string): string {
  return "personal:" + createHash("sha256").update(creationText(owner, 200)).digest("hex");
}
export function createMySQLCreationStorage(sql: SQL, namespace: string) {
  const tasks = new MySQLCreationLedger(sql, namespace);
  return { tasks, queue: tasks.scheduling, questions: tasks.questions };
}
