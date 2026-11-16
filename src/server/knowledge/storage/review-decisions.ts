import type { Database } from "bun:sqlite";
import type { KnowledgeReviewDecisions, KnowledgeReviewLease } from "../review/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { currentAutomaticReview } from "./review-executions.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";

/** Only a current independent review can admit the exact draft it examined. */
export class KnowledgeReviewDecisionsStore implements KnowledgeReviewDecisions {
  constructor(private readonly db: Database) {}
  latest(owner: string, taskId: string) {
    return this.latestFor(owner, [taskId])[0] ?? null;
  }
  latestFor(owner: string, taskIds: readonly string[]) {
    const ids = [...new Set(taskIds)];
    if (ids.length > KNOWLEDGE_LIMITS.pageSize) throw new KnowledgeTaskError("invalidInput");
    if (!ids.length) return [];
    return this.db
      .query<KnowledgeReviewLease, string[]>(
        `SELECT r.* FROM knowledge_reviews r JOIN (
          SELECT id,ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY taskRevision DESC,policyRevision DESC,createdAt DESC,id DESC) AS position
          FROM knowledge_reviews WHERE owner=? AND taskId IN (${ids.map(() => "?").join(",")})
        ) ranked ON ranked.id=r.id WHERE ranked.position=1`,
      )
      .all(owner, ...ids);
  }
  finish(review: KnowledgeReviewLease, reportDigest: string, approved: boolean, now: number) {
    this.db
      .transaction(() => {
        if (!currentAutomaticReview(this.db, review)) throw new KnowledgeTaskError("leaseLost");
        const changed = this.db
          .query(
            `UPDATE knowledge_reviews SET state=?,reportDigest=?,finishedAt=?
        WHERE id=? AND token=? AND state='running' AND leaseUntil>? AND sessionId=? AND runId=?`,
          )
          .run(
            approved ? "passed" : "needsReview",
            reportDigest,
            now,
            review.id,
            review.token,
            now,
            review.sessionId,
            review.runId,
          );
        if (!changed.changes) throw new KnowledgeTaskError("leaseLost");
      })
      .immediate();
  }
  admit(review: KnowledgeReviewLease, reportDigest: string, outputDigest: string, now: number) {
    this.db
      .transaction(() => {
        if (
          !currentAutomaticReview(this.db, review) ||
          !this.db
            .query(
              `SELECT 1 FROM knowledge_reviews
        WHERE id=? AND token=? AND state='passed' AND reportDigest=?`,
            )
            .get(review.id, review.token, reportDigest)
        )
          throw new KnowledgeTaskError("conflict");
        const changed = this.db
          .query(
            `UPDATE knowledge_tasks SET state='committing',outputDigest=?,updatedAt=?
        WHERE id=? AND owner=? AND state='review' AND reviewRevision=? AND draftDigest=? AND autoEligible=1`,
          )
          .run(outputDigest, now, review.taskId, review.owner, review.taskRevision, review.draftDigest);
        if (!changed.changes) throw new KnowledgeTaskError("conflict");
      })
      .immediate();
  }
  pending() {
    return this.db
      .query<KnowledgeReviewLease, []>(
        `SELECT r.* FROM knowledge_reviews r
      JOIN knowledge_tasks t ON t.id=r.taskId JOIN knowledge_review_policies p ON p.owner=r.owner AND p.project=r.project
      WHERE r.state='passed' AND t.state='review' AND t.autoEligible=1 AND t.reviewRevision=r.taskRevision
      AND t.draftDigest=r.draftDigest AND p.automatic=1 AND p.revision=r.policyRevision ORDER BY r.createdAt LIMIT 1`,
      )
      .get();
  }
}
