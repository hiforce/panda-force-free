import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeExecution,
  type KnowledgeTaskReads,
  type KnowledgeExecutionTasks,
} from "../tasks/contracts.js";
/** Owns reviews metadata transitions on the application's one transactional connection. */
export class MySQLKnowledgeTaskReviews {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly reads: Pick<AsyncMetadataStore<KnowledgeTaskReads>, "get">,
    private readonly execution: Pick<AsyncMetadataStore<KnowledgeExecutionTasks>, "assertExecution">,
  ) {}
  async question(scope: KnowledgeExecution, dialogueDigest: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const task = await this.execution.assertExecution(scope, now);
        if (task.rounds >= KNOWLEDGE_LIMITS.rounds) throw new KnowledgeTaskError("budget");
        await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='waiting',rounds=rounds+1,dialogueDigest=?,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          [dialogueDigest, now, task.id],
        );
        return await this.reads.get(scope.owner, task.id);
      });
    });
  }
  async draft(scope: KnowledgeExecution, draftDigest: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.execution.assertExecution(scope, now);
        await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='review',draftDigest=?,reviewRevision=reviewRevision+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE id=?",
          [draftDigest, now, scope.taskId],
        );
        return await this.reads.get(scope.owner, scope.taskId);
      });
    });
  }
  async answer(owner: string, id: string, previous: string, dialogueDigest: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const changed = await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='queued',dialogueDigest=?,updatedAt=? WHERE owner=? AND id=? AND state='waiting' AND dialogueDigest=? AND attempts<? AND failures<3",
          [dialogueDigest, now, owner, id, previous, KNOWLEDGE_LIMITS.rounds + KNOWLEDGE_LIMITS.attempts],
        );
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
        await this.db.execute(
          "UPDATE panda_force_knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?",
          [id, owner],
        );
        return await this.reads.get(owner, id);
      });
    });
  }
  async edit(owner: string, id: string, revision: number, digest: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const changed = await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET draftDigest=?,reviewRevision=reviewRevision+1,autoEligible=0,updatedAt=? WHERE owner=? AND id=? AND state='review' AND reviewRevision=?",
          [digest, now, owner, id, revision],
        );
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
        await this.db.execute(
          "UPDATE panda_force_knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?",
          [id, owner],
        );
        return await this.reads.get(owner, id);
      });
    });
  }
  async admit(owner: string, id: string, revision: number, outputDigest: string, now: number) {
    return await this.db.atomic(async () => {
      const task = await this.reads.get(owner, id);
      if (
        ["committing", "completed"].includes(task.state) &&
        task.reviewRevision === revision &&
        task.outputDigest === outputDigest
      )
        return task;
      const changed = await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET state='committing',outputDigest=?,updatedAt=? WHERE owner=? AND id=? AND state='review' AND reviewRevision=?",
        [outputDigest, now, owner, id, revision],
      );
      if (!changed.changes) throw new KnowledgeTaskError("conflict");
      return await this.reads.get(owner, id);
    });
  }
  async cancel(owner: string, id: string, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const task = await this.reads.get(owner, id);
        if (task.state === "cancelled") return task;
        // Once a file/Git write is admitted, its recovery owns the outcome. Cancellation cannot undo a commit.
        if (["committing", "completed"].includes(task.state)) throw new KnowledgeTaskError("conflict");
        await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='cancelled',generation=generation+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=? WHERE owner=? AND id=?",
          [now, owner, id],
        );
        return await this.reads.get(owner, id);
      });
    });
  }
}
