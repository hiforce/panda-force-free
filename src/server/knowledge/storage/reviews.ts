import type { Database } from "bun:sqlite";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeReviewTasks,
  type KnowledgeExecution,
  type KnowledgeTaskReads,
  type KnowledgeExecutionTasks,
} from "../tasks/contracts.js";

/** Owns reviews metadata transitions on the application's one transactional connection. */
export class KnowledgeTaskReviews implements KnowledgeReviewTasks {
  constructor(
    private readonly db: Database,
    private readonly reads: Pick<KnowledgeTaskReads, "get">,
    private readonly execution: Pick<KnowledgeExecutionTasks, "assertExecution">,
  ) {}
  question(scope: KnowledgeExecution, dialogueDigest: string, now: number) {
    return this.db
      .transaction(() => {
        const task = this.execution.assertExecution(scope, now);
        if (task.rounds >= KNOWLEDGE_LIMITS.rounds) throw new KnowledgeTaskError("budget");
        this.db
          .query(
            "UPDATE knowledge_tasks SET state='waiting',rounds=rounds+1,dialogueDigest=?,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          )
          .run(dialogueDigest, now, task.id);
        return this.reads.get(scope.owner, task.id);
      })
      .immediate();
  }

  draft(scope: KnowledgeExecution, draftDigest: string, now: number) {
    return this.db
      .transaction(() => {
        this.execution.assertExecution(scope, now);
        this.db
          .query(
            "UPDATE knowledge_tasks SET state='review',draftDigest=?,reviewRevision=reviewRevision+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          )
          .run(draftDigest, now, scope.taskId);
        return this.reads.get(scope.owner, scope.taskId);
      })
      .immediate();
  }

  answer(owner: string, id: string, previous: string, dialogueDigest: string, now: number) {
    return this.db
      .transaction(() => {
        const changed = this.db
          .query(
            "UPDATE knowledge_tasks SET state='queued',dialogueDigest=?,updatedAt=? WHERE owner=? AND id=? AND state='waiting' AND dialogueDigest=? AND attempts<? AND failures<3",
          )
          .run(dialogueDigest, now, owner, id, previous, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts);
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
        this.db.query("UPDATE knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?").run(id, owner);
        return this.reads.get(owner, id);
      })
      .immediate();
  }

  edit(owner: string, id: string, revision: number, digest: string, now: number) {
    return this.db
      .transaction(() => {
        const changed = this.db
          .query(
            "UPDATE knowledge_tasks SET draftDigest=?,reviewRevision=reviewRevision+1,autoEligible=0,updatedAt=? WHERE owner=? AND id=? AND state='review' AND reviewRevision=?",
          )
          .run(digest, now, owner, id, revision);
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
        this.db.query("UPDATE knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?").run(id, owner);
        return this.reads.get(owner, id);
      })
      .immediate();
  }

  admit(owner: string, id: string, revision: number, outputDigest: string, now: number) {
    const task = this.reads.get(owner, id);
    if (
      ["committing", "completed"].includes(task.state) &&
      task.reviewRevision === revision &&
      task.outputDigest === outputDigest
    )
      return task;
    const changed = this.db
      .query(
        "UPDATE knowledge_tasks SET state='committing',outputDigest=?,updatedAt=? WHERE owner=? AND id=? AND state='review' AND reviewRevision=?",
      )
      .run(outputDigest, now, owner, id, revision);
    if (!changed.changes) throw new KnowledgeTaskError("conflict");
    return this.reads.get(owner, id);
  }

  cancel(owner: string, id: string, now: number) {
    return this.db
      .transaction(() => {
        const task = this.reads.get(owner, id);
        if (task.state === "cancelled") return task;
        // Once a file/Git write is admitted, its recovery owns the outcome. Cancellation cannot undo a commit.
        if (["committing", "completed"].includes(task.state)) throw new KnowledgeTaskError("conflict");
        this.db
          .query(
            "UPDATE knowledge_tasks SET state='cancelled',generation=generation+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE owner=? AND id=?",
          )
          .run(now, owner, id);
        return this.reads.get(owner, id);
      })
      .immediate();
  }
}
