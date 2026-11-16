import type { Database } from "bun:sqlite";
import type { CreationExecution } from "../contracts.js";
import { CreationError } from "../contracts.js";
import type { CreationQuestionRecord, CreationQuestionStore } from "../questions/contracts.js";
import type { CreationTaskRepository } from "./repository.js";
import { creationDigest, creationInteger, creationUuid, creationUuidFromDigest } from "../validation.js";
import { readCreationTask, creationSignature } from "./records.js";

/** An unanswered question survives a worker restart. It blocks reclaim until its owner answers or cancels. */
export class CreationQuestionRepository implements CreationQuestionStore {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<CreationTaskRepository, "get" | "assertExecution">,
  ) {}
  task(owner: string, id: string) {
    return this.tasks.get(owner, id);
  }
  assert(scope: CreationExecution, now: number) {
    this.tasks.assertExecution(scope, now);
  }
  get(owner: string, id: string) {
    const row = this.db
      .query<CreationQuestionRecord, [string, string]>("SELECT * FROM creation_questions WHERE owner=? AND id=?")
      .get(owner, creationUuid(id));
    if (!row) throw new CreationError("notFound");
    return row;
  }
  pending(owner: string, taskId: string) {
    this.task(owner, taskId);
    return this.db
      .query<CreationQuestionRecord, [string, string]>(
        "SELECT * FROM creation_questions WHERE owner=? AND taskId=? AND state='pending'",
      )
      .get(owner, taskId);
  }
  register(scope: CreationExecution, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.db
      .transaction(() => {
        const task = this.tasks.assertExecution(scope, now),
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
        const existing = this.db
          .query<CreationQuestionRecord, [string]>("SELECT * FROM creation_questions WHERE id=?")
          .get(id);
        if (existing) return existing;
        if (this.pending(scope.owner, scope.taskId) || this.answered(scope.owner, scope.taskId).length >= 16)
          throw new CreationError("conflict");
        this.db
          .query(
            "INSERT INTO creation_questions(id,taskId,owner,generation,questionDigest,state,createdAt) VALUES(?,?,?,?,?,'pending',?)",
          )
          .run(id, scope.taskId, scope.owner, scope.generation, digest, now);
        return this.get(scope.owner, id);
      })
      .immediate();
  }
  answer(owner: string, id: string, digest: string, now: number) {
    creationDigest(digest);
    creationInteger(now);
    return this.db
      .transaction(() => {
        const question = this.get(owner, id),
          task = readCreationTask(this.db, owner, question.taskId);
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
        this.db
          .query(
            "UPDATE creation_questions SET state='answered',answerDigest=?,answeredAt=? WHERE id=? AND state='pending'",
          )
          .run(digest, now, id);
        // A durable clarification can resume even when its detached run consumed the last attempt.
        this.db.query("UPDATE creation_tasks SET budget=MAX(1,budget) WHERE id=?").run(task.id);
        return this.get(owner, id);
      })
      .immediate();
  }
  answered(owner: string, taskId: string) {
    this.task(owner, taskId);
    return this.db
      .query<CreationQuestionRecord, [string, string]>(
        "SELECT * FROM creation_questions WHERE owner=? AND taskId=? AND state='answered' ORDER BY createdAt,id LIMIT 16",
      )
      .all(owner, taskId);
  }
}
