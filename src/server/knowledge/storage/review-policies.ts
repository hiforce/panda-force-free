import type { Database } from "bun:sqlite";
import type { KnowledgeReviewPolicies } from "../review/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

/** Policy changes fence outstanding automatic decisions in the same short metadata transaction. */
export class KnowledgeReviewPoliciesStore implements KnowledgeReviewPolicies {
  constructor(private readonly db: Database) {}
  policy(owner: string, project: string) {
    const row = this.db
      .query<{ automatic: number; revision: number }, [string, string]>(
        "SELECT automatic,revision FROM knowledge_review_policies WHERE owner=? AND project=?",
      )
      .get(owner, project);
    return { automatic: row?.automatic === 1, revision: row?.revision ?? 0 };
  }
  configure(owner: string, project: string, automatic: boolean, revision: number, now: number) {
    return this.db
      .transaction(() => {
        if (this.policy(owner, project).revision !== revision) throw new KnowledgeTaskError("conflict");
        this.db
          .query(
            `INSERT INTO knowledge_review_policies VALUES(?,?,?,?,?)
        ON CONFLICT(owner,project) DO UPDATE SET automatic=excluded.automatic,revision=excluded.revision,updatedAt=excluded.updatedAt`,
          )
          .run(owner, project, automatic ? 1 : 0, revision + 1, now);
        this.db
          .query(
            `UPDATE knowledge_reviews SET state='superseded',finishedAt=? WHERE owner=? AND project=?
        AND (state='running' OR (state='passed' AND EXISTS(SELECT 1 FROM knowledge_tasks t WHERE t.id=knowledge_reviews.taskId AND t.state='review')))`,
          )
          .run(now, owner, project);
        return this.policy(owner, project);
      })
      .immediate();
  }
}
