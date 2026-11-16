import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeTaskSubmissions,
  type KnowledgeTaskRow,
  type KnowledgeTaskReads,
  type KnowledgeSubmission,
  type KnowledgeSubmissionGuard,
} from "../tasks/contracts.js";
import { type StoredTask } from "./records.js";
const active = "('queued','running','waiting','review','committing')";

/** Owns submissions metadata transitions on the application's one transactional connection. */
export class KnowledgeTaskSubmissionsStore implements KnowledgeTaskSubmissions {
  constructor(
    private readonly db: Database,
    private readonly reads: KnowledgeTaskReads,
  ) {}
  create(input: KnowledgeSubmission, now: number, guard?: KnowledgeSubmissionGuard): KnowledgeTaskRow {
    return this.db
      .transaction(() => {
        const replay = this.reads.submission(input.owner, input.operationId, input.requestHash);
        if (replay) {
          if (!guard) this.adopt(input.owner, replay.id);
          this.guard(guard, replay.id, false, now);
          return this.reads.get(input.owner, replay.id);
        }
        const same = this.db
          .query<StoredTask, [string, string]>(
            `SELECT * FROM knowledge_tasks WHERE owner=? AND signature=? AND state IN ${active}`,
          )
          .get(input.owner, input.signature);
        const id = same?.id ?? randomUUID();
        if (!same) {
          const count = this.db
            .query<{ count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM knowledge_tasks WHERE owner=? AND state IN ${active}`,
            )
            .get(input.owner)!.count;
          if (count >= KNOWLEDGE_LIMITS.pendingPerOwner) throw new KnowledgeTaskError("budget");
          this.db
            .query(
              "INSERT INTO knowledge_tasks(id,owner,project,title,signature,inputDigest,dialogueDigest,state,createdAt,updatedAt,autoEligible) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)",
            )
            .run(
              id,
              input.owner,
              input.project,
              input.title,
              input.signature,
              input.inputDigest,
              input.dialogueDigest,
              now,
              now,
              input.autoEligible === false ? 0 : 1,
            );
        }
        this.db
          .query("INSERT INTO knowledge_submissions(owner,operationId,requestHash,taskId) VALUES(?,?,?,?)")
          .run(input.owner, input.operationId, input.requestHash, id);
        this.guard(guard, id, !same, now);
        if (!guard) this.adopt(input.owner, id);
        return this.reads.get(input.owner, id);
      })
      .immediate();
  }
  private guard(guard: KnowledgeSubmissionGuard | undefined, id: string, created: boolean, now: number) {
    const outcome = guard?.(id, created, now);
    if (outcome instanceof Promise) {
      void outcome.catch(() => {});
      throw new KnowledgeTaskError("unavailable");
    }
  }
  /** An explicit manual request takes over a reused automatic task; later rule changes must preserve it. */
  private adopt(owner: string, id: string) {
    this.db.query("UPDATE knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?").run(id, owner);
  }
}
