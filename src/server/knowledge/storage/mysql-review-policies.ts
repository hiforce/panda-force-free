import type { MySQLMetadataContext } from "./mysql-context.js";

import { KnowledgeTaskError } from "../tasks/contracts.js";
/** Policy changes fence outstanding automatic decisions in the same short metadata transaction. */
export class MySQLKnowledgeReviewPoliciesStore {
  constructor(private readonly db: MySQLMetadataContext) {}
  async policy(owner: string, project: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<{
        automatic: number;
        revision: number;
      }>("SELECT automatic,revision FROM panda_force_knowledge_review_policies WHERE owner=? AND project=?", [
        owner,
        project,
      ]);
      return { automatic: row?.automatic === 1, revision: row?.revision ?? 0 };
    });
  }
  async configure(owner: string, project: string, automatic: boolean, revision: number, now: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        if ((await this.policy(owner, project)).revision !== revision) throw new KnowledgeTaskError("conflict");
        await this.db.execute(
          `INSERT INTO panda_force_knowledge_review_policies VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE automatic=VALUES(automatic),revision=VALUES(revision),updatedAt=VALUES(updatedAt)`,
          [owner, project, automatic ? 1 : 0, revision + 1, now],
        );
        await this.db.execute(
          `UPDATE panda_force_knowledge_reviews SET state='superseded',finishedAt=? WHERE owner=? AND project=?
        AND (state='running' OR (state='passed' AND EXISTS(SELECT 1 FROM panda_force_knowledge_tasks t WHERE t.id=panda_force_knowledge_reviews.taskId AND t.state='review')))`,
          [now, owner, project],
        );
        return await this.policy(owner, project);
      });
    });
  }
}
