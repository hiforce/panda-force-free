import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ApplicationRunScope } from "../../../shared/engine/application-tools.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { KnowledgeTaskReads } from "../tasks/contracts.js";
import type { KnowledgeReviewExecutions, KnowledgeReviewLease } from "../review/contracts.js";

export function currentAutomaticReview(db: Database, review: KnowledgeReviewLease) {
  return !!db
    .query(
      `SELECT 1 FROM knowledge_tasks t JOIN knowledge_review_policies p
    ON p.owner=t.owner AND p.project=t.project WHERE t.id=? AND t.owner=? AND t.state='review'
    AND t.autoEligible=1 AND t.reviewRevision=? AND t.inputDigest=? AND t.dialogueDigest=? AND t.draftDigest=?
    AND p.automatic=1 AND p.revision=?`,
    )
    .get(
      review.taskId,
      review.owner,
      review.taskRevision,
      review.inputDigest,
      review.dialogueDigest,
      review.draftDigest,
      review.policyRevision,
    );
}

/** An expired or interrupted review falls back to manual review instead of silently calling a model again. */
export class KnowledgeReviewExecutionsStore implements KnowledgeReviewExecutions {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<KnowledgeTaskReads, "get">,
  ) {}
  claim(now: number) {
    return this.db
      .transaction(() => {
        this.db
          .query("UPDATE knowledge_reviews SET state='failed',finishedAt=? WHERE state='running' AND leaseUntil<=?")
          .run(now, now);
        const row = this.db
          .query<{ id: string; owner: string; revision: number }, []>(
            `SELECT t.id,t.owner,p.revision
        FROM knowledge_tasks t JOIN knowledge_review_policies p ON p.owner=t.owner AND p.project=t.project
        WHERE t.state='review' AND t.autoEligible=1 AND p.automatic=1
        AND NOT EXISTS(SELECT 1 FROM knowledge_tasks x WHERE x.owner=t.owner AND x.state='running')
        AND NOT EXISTS(SELECT 1 FROM knowledge_reviews x WHERE x.owner=t.owner AND x.state='running')
        AND NOT EXISTS(SELECT 1 FROM knowledge_reviews x WHERE x.taskId=t.id AND x.taskRevision=t.reviewRevision AND x.policyRevision=p.revision)
        AND (SELECT count(*) FROM knowledge_reviews x WHERE x.taskId=t.id AND x.taskRevision=t.reviewRevision)<2
        ORDER BY t.updatedAt,t.id LIMIT 1`,
          )
          .get();
        if (!row) return null;
        const task = this.tasks.get(row.owner, row.id),
          id = randomUUID(),
          token = randomUUID();
        this.db
          .query(
            `INSERT INTO knowledge_reviews(id,taskId,owner,project,taskRevision,policyRevision,
        inputDigest,dialogueDigest,draftDigest,state,token,leaseUntil,createdAt) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?)`,
          )
          .run(
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
          );
        return {
          task,
          review: this.db.query<KnowledgeReviewLease, [string]>("SELECT * FROM knowledge_reviews WHERE id=?").get(id)!,
        };
      })
      .immediate();
  }
  assert(review: KnowledgeReviewLease, now: number) {
    const row = this.db
      .query<KnowledgeReviewLease, [string, string]>(
        "SELECT * FROM knowledge_reviews WHERE id=? AND token=? AND state='running'",
      )
      .get(review.id, review.token);
    if (
      !row ||
      row.leaseUntil <= now ||
      !currentAutomaticReview(this.db, review) ||
      row.sessionId !== review.sessionId ||
      row.runId !== review.runId
    )
      throw new KnowledgeTaskError("leaseLost");
  }
  bind(review: KnowledgeReviewLease, scope: ApplicationRunScope, now: number) {
    return this.db
      .transaction(() => {
        this.assert(review, now);
        if (review.sessionId !== null || !scope.sessionId || !scope.runId) throw new KnowledgeTaskError("leaseLost");
        this.db
          .query("UPDATE knowledge_reviews SET sessionId=?,runId=? WHERE id=? AND token=?")
          .run(scope.sessionId, scope.runId, review.id, review.token);
        return { ...review, ...scope };
      })
      .immediate();
  }
  heartbeat(review: KnowledgeReviewLease, now: number) {
    this.db
      .transaction(() => {
        this.assert(review, now);
        this.db
          .query("UPDATE knowledge_reviews SET leaseUntil=? WHERE id=? AND token=?")
          .run(now + 30000, review.id, review.token);
      })
      .immediate();
  }
  fail(review: KnowledgeReviewLease, now: number) {
    this.db
      .query(
        `UPDATE knowledge_reviews SET state=?,finishedAt=? WHERE id=? AND token=?
      AND (state='running' OR (state='passed' AND EXISTS(SELECT 1 FROM knowledge_tasks t WHERE t.id=knowledge_reviews.taskId AND t.state='review')))`,
      )
      .run(currentAutomaticReview(this.db, review) ? "failed" : "superseded", now, review.id, review.token);
  }
}
