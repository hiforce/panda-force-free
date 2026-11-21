import { CreationError, type CreationExecution } from "../contracts.js";
import type { CreationQuestionRecord } from "../questions/contracts.js";
import { creationDigest, creationInteger, creationUuid, creationUuidFromDigest } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import type { MySQLCreationLeases } from "./mysql-leases.js";
import { mysqlCreationQuestionRow } from "./mysql-rows.js";
import type { MySQLCreationTasks } from "./mysql-tasks.js";
import { creationSignature } from "./records.js";

/** Questions operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationQuestions {
  constructor(
    private readonly context: MySQLCreationContext,
    private readonly tasks: MySQLCreationTasks,
    private readonly leases: MySQLCreationLeases,
  ) {}
  async question(owner: string, id: string): Promise<CreationQuestionRecord> {
    const rows = await this.context
      .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.context.namespace} AND owner=${owner} AND id=${creationUuid(id)}`;
    if (!rows.length) throw new CreationError("notFound");
    return mysqlCreationQuestionRow(rows[0]);
  }
  async pendingQuestion(owner: string, taskId: string) {
    return this.context.read(async () => {
      await this.tasks.get(owner, taskId);
      const rows = await this.context
        .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.context.namespace} AND owner=${owner} AND taskId=${taskId} AND state='pending'`;
      return rows.length ? mysqlCreationQuestionRow(rows[0]) : null;
    });
  }
  async register(scope: CreationExecution, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.context.transaction(async () => {
      const task = await this.leases.assertExecution(scope, now),
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
      const rows = await this.context
        .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.context.namespace} AND id=${id}`;
      if (rows.length) return mysqlCreationQuestionRow(rows[0]);
      if (
        (await this.pendingQuestion(scope.owner, scope.taskId)) ||
        (await this.answered(scope.owner, scope.taskId)).length >= 16
      )
        throw new CreationError("conflict");
      await this.context
        .sql`INSERT INTO panda_force_creation_questions(namespace,id,taskId,owner,generation,questionDigest,state,createdAt,pendingTaskId) VALUES(${this.context.namespace},${id},${scope.taskId},${scope.owner},${scope.generation},${digest},'pending',${now},${scope.taskId})`;
      return this.question(scope.owner, id);
    });
  }
  async answer(owner: string, id: string, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.context.transaction(async () => {
      const question = await this.question(owner, id),
        task = await this.tasks.row(owner, question.taskId);
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
      await this.context
        .sql`UPDATE panda_force_creation_questions SET state='answered',answerDigest=${digest},answeredAt=${now},pendingTaskId=NULL WHERE namespace=${this.context.namespace} AND id=${id} AND state='pending'`;
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET budget=GREATEST(1,budget) WHERE namespace=${this.context.namespace} AND id=${task.id}`;
      return this.question(owner, id);
    });
  }
  async answered(owner: string, taskId: string) {
    return this.context.read(async () => {
      await this.tasks.get(owner, taskId);
      return (
        await this.context
          .sql`SELECT * FROM panda_force_creation_questions WHERE namespace=${this.context.namespace} AND owner=${owner} AND taskId=${taskId} AND state='answered' ORDER BY createdAt,id LIMIT 16`
      ).map((r: Record<string, unknown>) => mysqlCreationQuestionRow(r));
    });
  }
}
