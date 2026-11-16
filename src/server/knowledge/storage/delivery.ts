import type { Database } from "bun:sqlite";
import type { KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import {
  KnowledgeTaskError,
  type KnowledgeDeliveryTasks,
  type KnowledgeTaskRow,
  type KnowledgeTaskReads,
} from "../tasks/contracts.js";
import { decodeTask, type StoredTask } from "./records.js";
import { KnowledgeCatalogStore } from "./catalog.js";
import type { KnowledgeCatalogProjection } from "../catalog/contracts.js";

/** Owns delivery metadata transitions on the application's one transactional connection. */
export class KnowledgeTaskDelivery implements KnowledgeDeliveryTasks {
  constructor(
    private readonly db: Database,
    private readonly reads: Pick<KnowledgeTaskReads, "get">,
  ) {}
  denyDelivery(owner: string, id: string, digest: string, now: number) {
    this.db
      .query(
        "UPDATE knowledge_tasks SET state='cancelled',generation=generation+1,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
      )
      .run(now, owner, id, digest);
  }
  complete(
    owner: string,
    id: string,
    digest: string,
    receipt: KnowledgeReceipt,
    now: number,
    projection?: KnowledgeCatalogProjection,
  ) {
    return this.db
      .transaction(() => {
        const changed = this.db
          .query(
            "UPDATE knowledge_tasks SET state='completed',result=?,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
          )
          .run(JSON.stringify(receipt), now, owner, id, digest);
        if (!changed.changes) {
          const task = this.reads.get(owner, id);
          if (
            task.state !== "completed" ||
            task.outputDigest !== digest ||
            JSON.stringify(task.result) !== JSON.stringify(receipt)
          )
            throw new KnowledgeTaskError("conflict");
        }
        const task = this.reads.get(owner, id);
        if (
          projection &&
          !new KnowledgeCatalogStore(this.db).save(
            { owner, taskId: id, project: task.project, outputDigest: digest, inputDigest: task.inputDigest, receipt },
            projection,
          )
        )
          throw new KnowledgeTaskError("conflict");
        return task;
      })
      .immediate();
  }

  outputFailed(owner: string, id: string, digest: string, now: number) {
    this.db
      .query(
        "UPDATE knowledge_tasks SET outputAttempts=outputAttempts+1,failure='unavailable',nextOutputAt=?+MIN(60000,1000*(1 << MIN(outputAttempts,6))),updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
      )
      .run(now, now, owner, id, digest);
  }
  rejectDelivery(owner: string, id: string, digest: string, reason: "sourceChanged" | "targetChanged", now: number) {
    this.db
      .query(
        "UPDATE knowledge_tasks SET state='stale',failure=?,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
      )
      .run(reason, now, owner, id, digest);
  }

  retryOutput(owner: string, id: string, now: number) {
    const changed = this.db
      .query(
        "UPDATE knowledge_tasks SET outputAttempts=0,nextOutputAt=0,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND failure='unavailable'",
      )
      .run(now, owner, id);
    if (!changed.changes) throw new KnowledgeTaskError("conflict");
    return this.reads.get(owner, id);
  }

  nextOutput(now = Date.now()): KnowledgeTaskRow | null {
    const found = this.db
      .query<StoredTask, [number]>(
        "SELECT * FROM knowledge_tasks WHERE state='committing' AND outputAttempts<6 AND nextOutputAt<=? ORDER BY updatedAt LIMIT 1",
      )
      .get(now);
    return found ? decodeTask(found) : null;
  }
}
