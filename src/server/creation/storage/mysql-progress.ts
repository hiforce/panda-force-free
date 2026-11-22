import { randomUUID } from "node:crypto";
import type { CreationProgress } from "../../../shared/creation/contracts.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import { type CreationLease } from "../contracts.js";
import { creationProgress } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import type { MySQLCreationTasks } from "./mysql-tasks.js";

/** Progress operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationProgress {
  constructor(
    private readonly context: MySQLCreationContext,
    private readonly tasks: MySQLCreationTasks,
  ) {}
  readonly progress = {
    record: async (lease: CreationLease, value: CreationProgress) => {
      const event = creationProgress(value);
      await this.context.transaction(async () => {
        const task = await this.tasks.row(lease.owner, lease.taskId);
        if (task.generation !== lease.generation || event.generation !== lease.generation) return;
        if (event.id) {
          const current = await this.context
            .sql`SELECT id FROM panda_force_creation_progress WHERE namespace=${this.context.namespace} AND id=${event.id} AND taskId=${lease.taskId} AND generation=${lease.generation}`;
          if (current.length) {
            await this.context
              .sql`UPDATE panda_force_creation_progress SET event=${JSON.stringify(event)} WHERE namespace=${this.context.namespace} AND id=${event.id}`;
            return;
          }
        }
        const [count] = await this.context
          .sql`SELECT COUNT(*) n FROM panda_force_creation_progress WHERE namespace=${this.context.namespace} AND taskId=${lease.taskId} AND generation=${lease.generation}`;
        if (mysqlInteger(count.n) >= 64 && event.stage !== "reply") return;
        await this.context
          .sql`INSERT INTO panda_force_creation_progress(namespace,id,taskId,generation,createdAt,ordinal,event) VALUES(${this.context.namespace},${event.id || randomUUID()},${lease.taskId},${lease.generation},${event.at},${mysqlInteger(count.n)},${JSON.stringify(event)})`;
      });
    },
    list: async (owner: string, id: string, conversation = true): Promise<CreationProgress[]> => {
      await this.tasks.row(owner, id);
      const rows = await this.context
        .sql`SELECT event FROM (SELECT event,generation,ordinal FROM panda_force_creation_progress WHERE namespace=${this.context.namespace} AND taskId=${id} AND (${conversation ? 1 : 0}=1 OR JSON_UNQUOTE(JSON_EXTRACT(event,'$.stage')) NOT IN ('message','reply')) ORDER BY generation DESC,ordinal DESC LIMIT 192) recent ORDER BY generation,ordinal`;
      return rows.map((row: { event: unknown }) => creationProgress(JSON.parse(String(row.event))));
    },
  };
}
