import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { randomUUID } from "node:crypto";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeTaskRow,
  type KnowledgeTaskReads,
  type KnowledgeSubmission,
  type KnowledgeSubmissionGuard,
} from "../tasks/contracts.js";
import { type StoredTask } from "./mysql-records.js";
const active = "('queued','running','waiting','review','committing')";
/** Owns submissions metadata transitions on the application's one transactional connection. */
export class MySQLKnowledgeTaskSubmissionsStore {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly reads: AsyncMetadataStore<KnowledgeTaskReads>,
  ) {}
  async create(input: KnowledgeSubmission, now: number, guard?: KnowledgeSubmissionGuard): Promise<KnowledgeTaskRow> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const replay = await this.reads.submission(input.owner, input.operationId, input.requestHash);
        if (replay) {
          if (!guard) await this.adopt(input.owner, replay.id);
          await guard?.(replay.id, false, now);
          return await this.reads.get(input.owner, replay.id);
        }
        const same = await this.db.one<StoredTask>(
          `SELECT * FROM panda_force_knowledge_tasks WHERE owner=? AND signature=? AND state IN ${active}`,
          [input.owner, input.signature],
        );
        const id = same?.id ?? randomUUID();
        if (!same) {
          const count = (await this.db.one<{
            count: number;
          }>(`SELECT COUNT(*) AS count FROM panda_force_knowledge_tasks WHERE owner=? AND state IN ${active}`, [
            input.owner,
          ]))!.count;
          if (count >= KNOWLEDGE_LIMITS.pendingPerOwner) throw new KnowledgeTaskError("budget");
          await this.db.execute(
            "INSERT INTO panda_force_knowledge_tasks(id,owner,project,title,signature,inputDigest,dialogueDigest,state,createdAt,updatedAt,autoEligible) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)",
            [
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
            ],
          );
        }
        await this.db.execute(
          "INSERT INTO panda_force_knowledge_submissions(owner,operationId,requestHash,taskId) VALUES(?,?,?,?)",
          [input.owner, input.operationId, input.requestHash, id],
        );
        await guard?.(id, !same, now);
        if (!guard) await this.adopt(input.owner, id);
        return await this.reads.get(input.owner, id);
      });
    });
  }
  /** An explicit manual request takes over a reused automatic task; later rule changes must preserve it. */
  private async adopt(owner: string, id: string) {
    return await this.db.atomic(async () => {
      await this.db.execute("UPDATE panda_force_knowledge_generation_origins SET manual=1 WHERE taskId=? AND owner=?", [
        id,
        owner,
      ]);
    });
  }
}
