import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import { randomUUID } from "node:crypto";
import type { ApplicationRunScope } from "../../../shared/engine/application-tools.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { KnowledgeTaskReads } from "../tasks/contracts.js";
import type { KnowledgeReviewLease } from "../review/contracts.js";
export async function mysqlCurrentAutomaticReview(db: MySQLMetadataContext, review: KnowledgeReviewLease) {
  return !!(await db.one(
    `SELECT 1 FROM panda_force_knowledge_tasks t JOIN panda_force_knowledge_review_policies p
    ON p.owner=t.owner AND p.project=t.project WHERE t.id=? AND t.owner=? AND t.state='review'
    AND t.autoEligible=1 AND t.reviewRevision=? AND t.inputDigest=? AND t.dialogueDigest=? AND t.draftDigest=?
    AND p.automatic=1 AND p.revision=?`,
    [
      review.taskId,
      review.owner,
      review.taskRevision,
      review.inputDigest,
      review.dialogueDigest,
      review.draftDigest,
      review.policyRevision,
    ],
  ));
}
/** An expired or interrupted review falls back to manual review instead of silently calling a model again. */
export class MySQLKnowledgeReviewExecutionsStore {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly tasks: Pick<AsyncMetadataStore<KnowledgeTaskReads>, "get">,
  ) {}
  async claim(now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.db.execute(
          "UPDATE panda_force_knowledge_reviews SET state='failed',finishedAt=? WHERE state='running' AND leaseUntil<=?",
          [now, now],
        );
        const row = await this.db.one<{
          id: string;
          owner: string;
          revision: number;
        }>(
          `SELECT t.id,t.owner,p.revision
        FROM panda_force_knowledge_tasks t JOIN panda_force_knowledge_review_policies p ON p.owner=t.owner AND p.project=t.project
        WHERE t.state='review' AND t.autoEligible=1 AND p.automatic=1
        AND NOT EXISTS(SELECT 1 FROM panda_force_knowledge_tasks x WHERE x.owner=t.owner AND x.state='running')
        AND NOT EXISTS(SELECT 1 FROM panda_force_knowledge_reviews x WHERE x.owner=t.owner AND x.state='running')
        AND NOT EXISTS(SELECT 1 FROM panda_force_knowledge_reviews x WHERE x.taskId=t.id AND x.taskRevision=t.reviewRevision AND x.policyRevision=p.revision)
        AND (SELECT count(*) FROM panda_force_knowledge_reviews x WHERE x.taskId=t.id AND x.taskRevision=t.reviewRevision)<2
        ORDER BY t.updatedAt,t.id LIMIT 1`,
          [],
        );
        if (!row) return null;
        const task = await this.tasks.get(row.owner, row.id),
          id = randomUUID(),
          token = randomUUID();
        await this.db.execute(
          `INSERT INTO panda_force_knowledge_reviews(id,taskId,owner,project,taskRevision,policyRevision,
        inputDigest,dialogueDigest,draftDigest,state,token,leaseUntil,createdAt) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?)`,
          [
            id,
            task.id,
            task.owner,
            task.project,
            task.reviewRevision,
            row.revision,
            task.inputDigest,
            task.dialogueDigest,
            task.draftDigest!,
            token,
            now + 30000,
            now,
          ],
        );
        return {
          task,
          review: (await this.db.one<KnowledgeReviewLease>("SELECT * FROM panda_force_knowledge_reviews WHERE id=?", [
            id,
          ]))!,
        };
      });
    });
  }
  async assert(review: KnowledgeReviewLease, now: number) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<KnowledgeReviewLease>(
        "SELECT * FROM panda_force_knowledge_reviews WHERE id=? AND token=? AND state='running'",
        [review.id, review.token],
      );
      if (
        !row ||
        row.leaseUntil <= now ||
        !(await mysqlCurrentAutomaticReview(this.db, review)) ||
        row.sessionId !== review.sessionId ||
        row.runId !== review.runId
      )
        throw new KnowledgeTaskError("leaseLost");
    });
  }
  async bind(review: KnowledgeReviewLease, scope: ApplicationRunScope, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        await this.assert(review, now);
        if (review.sessionId !== null || !scope.sessionId || !scope.runId) throw new KnowledgeTaskError("leaseLost");
        await this.db.execute("UPDATE panda_force_knowledge_reviews SET sessionId=?,runId=? WHERE id=? AND token=?", [
          scope.sessionId,
          scope.runId,
          review.id,
          review.token,
        ]);
        return { ...review, ...scope };
      });
    });
  }
  async heartbeat(review: KnowledgeReviewLease, now: number) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        await this.assert(review, now);
        await this.db.execute("UPDATE panda_force_knowledge_reviews SET leaseUntil=? WHERE id=? AND token=?", [
          now + 30000,
          review.id,
          review.token,
        ]);
      });
    });
  }
  async fail(review: KnowledgeReviewLease, now: number) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        `UPDATE panda_force_knowledge_reviews SET state=?,finishedAt=? WHERE id=? AND token=?
      AND (state='running' OR (state='passed' AND EXISTS(SELECT 1 FROM panda_force_knowledge_tasks t WHERE t.id=panda_force_knowledge_reviews.taskId AND t.state='review')))`,
        [(await mysqlCurrentAutomaticReview(this.db, review)) ? "failed" : "superseded", now, review.id, review.token],
      );
    });
  }
}
