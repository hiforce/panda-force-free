import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import type { KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import { KnowledgeTaskError, type KnowledgeTaskRow, type KnowledgeTaskReads } from "../tasks/contracts.js";
import { decodeTask, type StoredTask } from "./mysql-records.js";
import { MySQLKnowledgeCatalogStore } from "./mysql-catalog.js";
import type { KnowledgeCatalogProjection } from "../catalog/contracts.js";
/** Owns delivery metadata transitions on the application's one transactional connection. */
export class MySQLKnowledgeTaskDelivery {
  constructor(
    private readonly db: MySQLMetadataContext,
    private readonly reads: Pick<AsyncMetadataStore<KnowledgeTaskReads>, "get">,
  ) {}
  async denyDelivery(owner: string, id: string, digest: string, now: number) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET state='cancelled',generation=generation+1,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
        [now, owner, id, digest],
      );
    });
  }
  async complete(
    owner: string,
    id: string,
    digest: string,
    receipt: KnowledgeReceipt,
    now: number,
    projection?: KnowledgeCatalogProjection,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const changed = await this.db.execute(
          "UPDATE panda_force_knowledge_tasks SET state='completed',result=?,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
          [JSON.stringify(receipt), now, owner, id, digest],
        );
        if (!changed.changes) {
          const task = await this.reads.get(owner, id);
          if (
            task.state !== "completed" ||
            task.outputDigest !== digest ||
            JSON.stringify(task.result) !== JSON.stringify(receipt)
          )
            throw new KnowledgeTaskError("conflict");
        }
        const task = await this.reads.get(owner, id);
        if (
          projection &&
          !(await new MySQLKnowledgeCatalogStore(this.db).save(
            { owner, taskId: id, project: task.project, outputDigest: digest, inputDigest: task.inputDigest, receipt },
            projection,
          ))
        )
          throw new KnowledgeTaskError("conflict");
        return task;
      });
    });
  }
  async outputFailed(owner: string, id: string, digest: string, now: number) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET failure='unavailable',nextOutputAt=?+LEAST(60000,1000*(1 << LEAST(outputAttempts,6))),outputAttempts=outputAttempts+1,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
        [now, now, owner, id, digest],
      );
    });
  }
  async rejectDelivery(
    owner: string,
    id: string,
    digest: string,
    reason: "sourceChanged" | "targetChanged",
    now: number,
  ) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET state='stale',failure=?,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND outputDigest=?",
        [reason, now, owner, id, digest],
      );
    });
  }
  async retryOutput(owner: string, id: string, now: number) {
    return await this.db.atomic(async () => {
      const changed = await this.db.execute(
        "UPDATE panda_force_knowledge_tasks SET outputAttempts=0,nextOutputAt=0,failure=NULL,updatedAt=? WHERE owner=? AND id=? AND state='committing' AND failure='unavailable'",
        [now, owner, id],
      );
      if (!changed.changes) throw new KnowledgeTaskError("conflict");
      return await this.reads.get(owner, id);
    });
  }
  async nextOutput(now = Date.now()): Promise<KnowledgeTaskRow | null> {
    return await this.db.atomic(async () => {
      const found = await this.db.one<StoredTask>(
        "SELECT * FROM panda_force_knowledge_tasks WHERE state='committing' AND outputAttempts<6 AND nextOutputAt<=? ORDER BY updatedAt LIMIT 1",
        [now],
      );
      return found ? decodeTask(found) : null;
    });
  }
}
