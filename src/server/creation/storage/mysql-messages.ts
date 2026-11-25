import { creationUpdateGeneration } from "../../../shared/creation/contracts.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import { CreationError } from "../contracts.js";
import type { CreationMessageRecord, CreationMessageStore } from "../messages/contracts.js";
import { creationUuid } from "../validation.js";
import { MySQLCreationContext } from "./mysql-context.js";
import type { MySQLCreationLeases } from "./mysql-leases.js";
import { mysqlCreationMessageRow } from "./mysql-rows.js";
import type { MySQLCreationTasks } from "./mysql-tasks.js";

/** Messages operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationMessages {
  constructor(
    private readonly context: MySQLCreationContext,
    private readonly tasks: MySQLCreationTasks,
    private readonly leases: MySQLCreationLeases,
  ) {}
  async messageRow(owner: string, id: string): Promise<CreationMessageRecord | null> {
    const rows = await this.context
      .sql`SELECT * FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND id=${creationUuid(id)}`;
    if (!rows.length) return null;
    if (rows[0].owner !== owner) throw new CreationError("notFound");
    return mysqlCreationMessageRow(rows[0]);
  }
  readonly messages: CreationMessageStore = {
    find: (owner, id) => this.messageRow(owner, id),
    accept: (value) =>
      this.context.transaction(async () => {
        const prior = await this.messageRow(value.owner, value.id);
        if (prior) {
          if (prior.requestDigest !== value.requestDigest || prior.taskId !== value.taskId)
            throw new CreationError("conflict");
          return prior;
        }
        const task = await this.tasks.row(value.owner, value.taskId);
        if (
          !["queued", "running"].includes(task.state) ||
          task.cancelRequested ||
          task.outputDigest ||
          (task.generation !== value.generation && creationUpdateGeneration(task) !== value.generation)
        )
          throw new CreationError("conflict");
        const [count] = await this.context
          .sql`SELECT COUNT(*) n FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND taskId=${value.taskId}`;
        if (mysqlInteger(count.n) >= 32) throw new CreationError("unavailable");
        const [previous] = await this.context
          .sql`SELECT MAX(createdAt) at FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND taskId=${value.taskId}`;
        const acceptedAt = Math.max(
          value.createdAt,
          previous.at === null ? value.createdAt : mysqlInteger(previous.at) + 1,
        );
        await this.context
          .sql`INSERT INTO panda_force_creation_messages(namespace,id,owner,taskId,generation,requestDigest,payloadDigest,state,dispatchGeneration,createdAt,updatedAt) VALUES(${this.context.namespace},${value.id},${value.owner},${value.taskId},${value.generation},${value.requestDigest},${value.payloadDigest},'received',NULL,${acceptedAt},${Math.max(acceptedAt, value.updatedAt)})`;
        return (await this.messageRow(value.owner, value.id))!;
      }),
    list: async (owner, taskId) => {
      await this.tasks.row(owner, taskId);
      return (
        await this.context
          .sql`SELECT * FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND taskId=${taskId} ORDER BY createdAt,id`
      ).map((row: Record<string, unknown>) => mysqlCreationMessageRow(row));
    },
    claim: (lease, now) =>
      this.context.transaction(async () => {
        let task;
        try {
          task = await this.leases.active(lease, now);
        } catch (error) {
          if (error instanceof CreationError && error.code === "leaseLost") return null;
          throw error;
        }
        if (task.state !== "running") return null;
        await this.context
          .sql`UPDATE panda_force_creation_messages SET state='uncertain',updatedAt=${now} WHERE namespace=${this.context.namespace} AND taskId=${lease.taskId} AND state='dispatching' AND dispatchGeneration<>${lease.generation}`;
        const [row] = await this.context
          .sql`SELECT * FROM panda_force_creation_messages WHERE namespace=${this.context.namespace} AND taskId=${lease.taskId} AND state='received' ORDER BY createdAt,id LIMIT 1`;
        if (!row) return null;
        await this.context
          .sql`UPDATE panda_force_creation_messages SET state='dispatching',dispatchGeneration=${lease.generation},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${row.id}`;
        return this.messageRow(lease.owner, row.id);
      }),
    settle: (lease, id, state, now) =>
      this.context.transaction(async () => {
        const task = await this.tasks.row(lease.owner, lease.taskId);
        if (task.generation !== lease.generation) return;
        await this.context
          .sql`UPDATE panda_force_creation_messages SET state=${state},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id} AND owner=${lease.owner} AND taskId=${lease.taskId} AND dispatchGeneration=${lease.generation} AND state='dispatching'`;
      }),
    seen: (lease, ids, now) =>
      this.context.transaction(async () => {
        await this.leases.active(lease, now);
        for (const id of ids)
          await this.context
            .sql`UPDATE panda_force_creation_messages SET state='delivered',dispatchGeneration=${lease.generation},updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id} AND owner=${lease.owner} AND taskId=${lease.taskId} AND state<>'delivered'`;
      }),
  };
}
