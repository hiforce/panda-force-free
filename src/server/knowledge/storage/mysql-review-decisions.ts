import type { MySQLMetadataContext } from "./mysql-context.js";

import type { KnowledgeReviewLease } from "../review/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { mysqlCurrentAutomaticReview } from "./mysql-review-executions.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
/** Only a current independent review can admit the exact draft it examined. */
export class MySQLKnowledgeReviewDecisionsStore {
  constructor(private readonly db: MySQLMetadataContext) {}
  async latest(owner: string, taskId: string) {
    return (await this.latestFor(owner, [taskId]))[0] ?? null;
  }
  async latestFor(owner: string, taskIds: readonly string[]) {
    const ids = [...new Set(taskIds)];
    if (ids.length > KNOWLEDGE_LIMITS.pageSize) throw new KnowledgeTaskError("invalidInput");
    if (!ids.length) return [];
    return await this.db.atomic(async () => {
      return await this.db.all<KnowledgeReviewLease>(
        `SELECT r.* FROM panda_force_knowledge_reviews r JOIN (
          SELECT id,ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY taskRevision DESC,policyRevision DESC,createdAt DESC,id DESC) AS position
          FROM panda_force_knowledge_reviews WHERE owner=? AND taskId IN (${ids.map(() => "?").join(",")})
        ) ranked ON ranked.id=r.id WHERE ranked.position=1`,
        [owner, ...ids],
      );
    });
  }
  async finish(review: KnowledgeReviewLease, reportDigest: string, approved: boolean, now: number) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        if (!(await mysqlCurrentAutomaticReview(this.db, review))) throw new KnowledgeTaskError("leaseLost");
        const changed = await this.db.execute(
          `UPDATE panda_force_knowledge_reviews SET state=?,reportDigest=?,finishedAt=?
        WHERE id=? AND token=? AND state='running' AND leaseUntil>? AND sessionId=? AND runId=?`,
          [
            approved ? "passed" : "needsReview",
            reportDigest,
            now,
            review.id,
            review.token,
            now,
            review.sessionId,
            review.runId,
          ],
        );
        if (!changed.changes) throw new KnowledgeTaskError("leaseLost");
      });
    });
  }
  async admit(review: KnowledgeReviewLease, reportDigest: string, outputDigest: string, now: number) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        if (
          !(await mysqlCurrentAutomaticReview(this.db, review)) ||
          !(await this.db.one(
            `SELECT 1 FROM panda_force_knowledge_reviews
        WHERE id=? AND token=? AND state='passed' AND reportDigest=?`,
            [review.id, review.token, reportDigest],
          ))
        )
          throw new KnowledgeTaskError("conflict");
        const changed = await this.db.execute(
          `UPDATE panda_force_knowledge_tasks SET state='committing',outputDigest=?,updatedAt=?
        WHERE id=? AND owner=? AND state='review' AND reviewRevision=? AND draftDigest=? AND autoEligible=1`,
          [outputDigest, now, review.taskId, review.owner, review.taskRevision, review.draftDigest],
        );
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
      });
    });
  }
  async pending() {
    return await this.db.atomic(async () => {
      return await this.db.one<KnowledgeReviewLease>(
        `SELECT r.* FROM panda_force_knowledge_reviews r
      JOIN panda_force_knowledge_tasks t ON t.id=r.taskId JOIN panda_force_knowledge_review_policies p ON p.owner=r.owner AND p.project=r.project
      WHERE r.state='passed' AND t.state='review' AND t.autoEligible=1 AND t.reviewRevision=r.taskRevision
      AND t.draftDigest=r.draftDigest AND p.automatic=1 AND p.revision=r.policyRevision ORDER BY r.createdAt LIMIT 1`,
        [],
      );
    });
  }
}
