import type { Database } from "bun:sqlite";
import type { KnowledgeAccessScope, KnowledgeAccessStore } from "../tasks/access.js";

/** Revocation fences all uncommitted work, including manually adopted tasks, in one metadata transaction. */
export class KnowledgeAccessScopes implements KnowledgeAccessStore {
  constructor(private db: Database) {}
  next(after?: KnowledgeAccessScope): KnowledgeAccessScope | null {
    const candidates = [
      ["knowledge_tasks", "knowledge_access_tasks", "state IN ('queued','running','waiting','review')"],
      ["knowledge_generation_policies", "knowledge_access_generation", "enabled=1"],
      ["knowledge_review_policies", "knowledge_access_review", "automatic=1"],
    ].flatMap(([table, index, predicate]) => {
      const row = this.db
        .query<KnowledgeAccessScope, [string, string]>(
          `SELECT owner,project FROM ${table} INDEXED BY ${index} WHERE ${predicate} AND (owner,project)>(?,?) ORDER BY owner,project LIMIT 1`,
        )
        .get(after?.owner ?? "", after?.project ?? "");
      return row ? [row] : [];
    });
    return (
      candidates.sort((a, b) =>
        a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : 0,
      )[0] ?? null
    );
  }
  revoke({ owner, project }: KnowledgeAccessScope, now: number) {
    this.db
      .transaction(() => {
        this.db
          .query(
            `UPDATE knowledge_tasks SET state='cancelled',generation=generation+1,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=?
        WHERE owner=? AND project=? AND state IN ('queued','running','waiting','review')`,
          )
          .run(now, owner, project);
        this.db
          .query(
            `UPDATE knowledge_reviews SET state='superseded',finishedAt=? WHERE owner=? AND project=? AND state IN ('running','passed')
        AND EXISTS(SELECT 1 FROM knowledge_tasks t WHERE t.id=knowledge_reviews.taskId AND t.state NOT IN ('committing','completed'))`,
          )
          .run(now, owner, project);
        this.db
          .query(
            `UPDATE knowledge_generation_policies SET enabled=0,revision=revision+1,nextAdmissionAt=NULL,updatedAt=?
        WHERE owner=? AND project=? AND enabled=1`,
          )
          .run(now, owner, project);
        this.db.query("DELETE FROM knowledge_generation_jobs WHERE owner=? AND project=?").run(owner, project);
        this.db
          .query(
            "UPDATE knowledge_review_policies SET automatic=0,revision=revision+1,updatedAt=? WHERE owner=? AND project=? AND automatic=1",
          )
          .run(now, owner, project);
      })
      .immediate();
  }
}
