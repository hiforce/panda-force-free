import type { MySQLMetadataContext } from "./mysql-context.js";

import type { KnowledgeAccessScope } from "../tasks/access.js";
/** Revocation fences all uncommitted work, including manually adopted tasks, in one metadata transaction. */
export class MySQLKnowledgeAccessScopes {
  constructor(private db: MySQLMetadataContext) {}
  async next(after?: KnowledgeAccessScope): Promise<KnowledgeAccessScope | null> {
    return await this.db.atomic(async () => {
      const candidates: KnowledgeAccessScope[] = [];
      for (const [table, predicate] of [
        ["panda_force_knowledge_tasks", "state IN ('queued','running','waiting','review')"],
        ["panda_force_knowledge_generation_policies", "enabled=1"],
        ["panda_force_knowledge_review_policies", "automatic=1"],
      ]) {
        const row = await this.db.one<KnowledgeAccessScope>(
          `SELECT owner,project FROM ${table} WHERE ${predicate} AND (owner,project)>(?,?) ORDER BY owner,project LIMIT 1`,
          [after?.owner ?? "", after?.project ?? ""],
        );
        if (row) candidates.push(row);
      }
      return (
        candidates.sort((a, b) =>
          a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : 0,
        )[0] ?? null
      );
    });
  }
  async revoke({ owner, project }: KnowledgeAccessScope, now: number) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        await this.db.execute(
          `UPDATE panda_force_knowledge_tasks SET state='cancelled',generation=generation+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=?
        WHERE owner=? AND project=? AND state IN ('queued','running','waiting','review')`,
          [now, owner, project],
        );
        await this.db.execute(
          `UPDATE panda_force_knowledge_reviews SET state='superseded',finishedAt=? WHERE owner=? AND project=? AND state IN ('running','passed')
        AND EXISTS(SELECT 1 FROM panda_force_knowledge_tasks t WHERE t.id=panda_force_knowledge_reviews.taskId AND t.state NOT IN ('committing','completed'))`,
          [now, owner, project],
        );
        await this.db.execute(
          `UPDATE panda_force_knowledge_generation_policies SET enabled=0,revision=revision+1,nextAdmissionAt=NULL,updatedAt=?
        WHERE owner=? AND project=? AND enabled=1`,
          [now, owner, project],
        );
        await this.db.execute("DELETE FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=?", [
          owner,
          project,
        ]);
        await this.db.execute(
          "UPDATE panda_force_knowledge_review_policies SET automatic=0,revision=revision+1,updatedAt=? WHERE owner=? AND project=? AND automatic=1",
          [now, owner, project],
        );
      });
    });
  }
}
