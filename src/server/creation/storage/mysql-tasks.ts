import { stableJson } from "../../../shared/stable-json.js";
import { mysqlInteger } from "../../database/mysql-model.js";
import { CreationError, type CreationArtifact, type CreationFailure } from "../contracts.js";
import {
  creationHistoryCommand,
  historyReceipt,
  historySignature,
  type CreationHistoryCommand,
  type CreationHistoryTask,
} from "../history/contracts.js";
import {
  creationArtifact,
  creationId,
  creationInteger,
  creationTaskSpec,
  creationText,
  creationUuid,
} from "../validation.js";
import {
  creationHeadOrder,
  creationHistoryTask,
  creationLineageSql,
  creationRoundCursor,
  creationRoundPage,
} from "./lineage.js";
import { MySQLCreationContext } from "./mysql-context.js";
import { mysqlCreationLineageRow, mysqlCreationRoundRow, mysqlCreationTaskRow } from "./mysql-rows.js";
import { creationSignature, creationTask, type CreationTaskRow } from "./records.js";

/** Tasks operations borrow the shared transaction; this facet never owns a separate connection context. */
export class MySQLCreationTasks {
  constructor(private readonly context: MySQLCreationContext) {}
  async row(owner: string, id: string): Promise<CreationTaskRow> {
    const rows = await this.context
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND owner=${creationText(owner)} AND id=${creationUuid(id)}`;
    if (!rows.length) throw new CreationError("notFound");
    const row = mysqlCreationTaskRow(rows[0]);
    creationTask(row);
    return row;
  }
  async get(owner: string, id: string) {
    return creationTask(await this.row(owner, id));
  }
  async find(owner: string, id: string) {
    const rows = await this.context
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND id=${creationUuid(id)}`;
    if (!rows.length) return null;
    if (rows[0].owner !== creationText(owner)) throw new CreationError("notFound");
    return creationTask(mysqlCreationTaskRow(rows[0]));
  }
  async capacity(owner: string) {
    const [active] = await this.context
      .sql`SELECT COALESCE(SUM(owner=${owner}),0) AS own,COUNT(*) AS total FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND state IN ('queued','running','committing')`;
    if (mysqlInteger(active.own) >= 32 || mysqlInteger(active.total) >= 256) throw new CreationError("unavailable");
  }
  async create(value: unknown, now: number) {
    const spec = creationTaskSpec(value),
      signature = creationSignature(spec);
    creationInteger(now);
    return this.context.transaction(async () => {
      const prior = await this.find(spec.owner, spec.id);
      if (prior) {
        if (creationSignature(prior.spec) !== signature) throw new CreationError("conflict");
        return prior;
      }
      await this.capacity(spec.owner);
      if (
        (
          await this.context
            .sql`SELECT 1 FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND operationId=${spec.operationId}`
        ).length
      )
        throw new CreationError("conflict");
      await this.context
        .sql`INSERT INTO panda_force_creation_tasks(namespace,id,owner,projectId,operationId,spec,signature,state,createdAt,updatedAt) VALUES(${this.context.namespace},${spec.id},${spec.owner},${spec.projectId},${spec.operationId},${stableJson(spec)},${signature},'queued',${now},${now})`;
      return this.get(spec.owner, spec.id);
    });
  }
  async hasPending(id: string) {
    return (
      (
        await this.context
          .sql`SELECT 1 FROM panda_force_creation_questions WHERE namespace=${this.context.namespace} AND taskId=${id} AND state='pending'`
      ).length > 0
    );
  }
  async expire(id: string) {
    await this.context
      .sql`UPDATE panda_force_creation_questions SET state='expired',pendingTaskId=NULL WHERE namespace=${this.context.namespace} AND taskId=${id} AND state='pending'`;
  }
  async cancel(owner: string, id: string, now: number) {
    creationInteger(now);
    return this.context.transaction(async () => {
      const row = await this.row(owner, id);
      if (["succeeded", "replied", "failed", "cancelled"].includes(row.state)) return creationTask(row);
      await this.expire(id);
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET cancelRequested=1,state=CASE WHEN outputDigest IS NULL THEN 'cancelled' ELSE 'committing' END,token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id}`;
      return this.get(owner, id);
    });
  }
  async complete(owner: string, id: string, digest: string, artifact: CreationArtifact, now: number) {
    creationInteger(now);
    return this.context.transaction(async () => {
      const row = await this.row(owner, id),
        checked = creationArtifact(artifact, creationTask(row).spec);
      if (row.outputDigest !== digest) throw new CreationError("conflict");
      if (row.artifact !== null) {
        if (stableJson(checked) !== stableJson(JSON.parse(row.artifact))) throw new CreationError("conflict");
        return creationTask(row);
      }
      if (row.state !== "committing") throw new CreationError("conflict");
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET state=CASE WHEN cancelRequested=1 THEN 'cancelled' ELSE 'succeeded' END,artifact=${stableJson(checked)},failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id}`;
      if (!row.cancelRequested)
        await this.context
          .sql`INSERT IGNORE INTO panda_force_creation_notifications(namespace,taskId,owner,generation,createdAt) VALUES(${this.context.namespace},${id},${owner},${row.generation},${now})`;
      return this.get(owner, id);
    });
  }
  async notifications(
    owner: string,
    page?: Parameters<import("../ports.js").CreationNotificationStore["notifications"]>[1],
  ): Promise<import("../ports.js").CreationNotificationRecord[]> {
    const { sql, namespace } = this.context;
    const before = page?.before;
    const rows = page
      ? before
        ? await sql`SELECT taskId,generation,createdAt,readAt FROM panda_force_creation_notifications WHERE namespace=${namespace} AND owner=${creationText(owner)} AND (createdAt,taskId,generation)<(${before.createdAt},${before.taskId},${before.generation}) ORDER BY createdAt DESC,taskId DESC,generation DESC LIMIT ${page.limit}`
        : await sql`SELECT taskId,generation,createdAt,readAt FROM panda_force_creation_notifications WHERE namespace=${namespace} AND owner=${creationText(owner)} ORDER BY createdAt DESC,taskId DESC,generation DESC LIMIT ${page.limit}`
      : await sql`SELECT taskId,generation,createdAt,readAt FROM panda_force_creation_notifications WHERE namespace=${namespace} AND owner=${creationText(owner)} ORDER BY (readAt IS NULL) DESC,createdAt DESC,taskId DESC LIMIT 100`;
    return rows.map((row: Record<string, unknown>) => ({
      taskId: creationUuid(row.taskId),
      generation: mysqlInteger(row.generation),
      createdAt: mysqlInteger(row.createdAt),
      readAt: row.readAt === null ? null : mysqlInteger(row.readAt),
    }));
  }
  async readNotification(owner: string, taskId: string, generation: number, now: number) {
    creationInteger(generation);
    creationInteger(now);
    await this.context.transaction(async () => {
      const rows = await this.context
        .sql`SELECT 1 FROM panda_force_creation_notifications WHERE namespace=${this.context.namespace} AND owner=${creationText(owner)} AND taskId=${creationUuid(taskId)} AND generation=${generation}`;
      if (!rows.length) throw new CreationError("notFound");
      await this.context
        .sql`UPDATE panda_force_creation_notifications SET readAt=${now} WHERE namespace=${this.context.namespace} AND owner=${owner} AND taskId=${taskId} AND generation=${generation} AND readAt IS NULL`;
    });
  }
  async outputFailure(owner: string, id: string, digest: string, failure: CreationFailure, now: number) {
    creationInteger(now);
    await this.context.transaction(async () => {
      await this.context
        .sql`UPDATE panda_force_creation_tasks SET failure=${failure},updatedAt=${now} WHERE namespace=${this.context.namespace} AND owner=${owner} AND id=${id} AND outputDigest=${digest} AND state='committing' AND artifact IS NULL`;
    });
  }
  async pending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new CreationError("invalidInput");
    return (
      await this.context
        .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND state='committing' ORDER BY updatedAt,id LIMIT ${limit}`
    ).map((r: Record<string, unknown>) => creationTask(mysqlCreationTaskRow(r)));
  }
  async retry(owner: string, id: string, operationId: string, now: number) {
    creationUuid(operationId);
    creationInteger(now);
    return this.context.transaction(async () => {
      const row = await this.row(owner, id),
        request = creationSignature({ action: "retry", taskId: id }),
        previous = await this.context
          .sql`SELECT owner,request FROM panda_force_creation_actions WHERE namespace=${this.context.namespace} AND id=${operationId}`;
      if (previous.length) {
        if (previous[0].owner !== owner) throw new CreationError("notFound");
        if (previous[0].request !== request) throw new CreationError("conflict");
        return creationTask(row);
      }
      if (
        row.artifact !== null ||
        !(row.state === "failed" || row.state === "cancelled" || (row.state === "committing" && row.failure !== null))
      )
        throw new CreationError("conflict");
      if (row.outputDigest === null) {
        await this.capacity(owner);
        await this.context
          .sql`UPDATE panda_force_creation_tasks SET state='queued',budget=3,cancelRequested=0,failure=NULL,token=NULL,leaseUntil=NULL,sessionId=NULL,runId=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id}`;
      } else
        await this.context
          .sql`UPDATE panda_force_creation_tasks SET failure=NULL,updatedAt=${now} WHERE namespace=${this.context.namespace} AND id=${id}`;
      await this.context
        .sql`INSERT INTO panda_force_creation_actions(namespace,id,owner,taskId,request,createdAt) VALUES(${this.context.namespace},${operationId},${owner},${id},${request},${now})`;
      return this.get(owner, id);
    });
  }
  async clearHistory(owner: string, command: CreationHistoryCommand, now: number) {
    command = creationHistoryCommand(command);
    owner = creationText(owner, 200);
    creationInteger(now);
    const signature = historySignature(command);
    return this.context.transaction(async () => {
      const prior = await this.context
        .sql`SELECT owner,request,result FROM panda_force_creation_history_actions WHERE namespace=${this.context.namespace} AND id=${command.id}`;
      if (prior.length) {
        if (prior[0].owner !== owner) throw new CreationError("notFound");
        if (prior[0].request !== signature) throw new CreationError("conflict");
        return historyReceipt(prior[0].result, command.id);
      }
      const task = command.taskId ? await this.get(owner, command.taskId) : null;
      let hidden = 0;
      if (task) {
        const rows = await this.context.sql.unsafe(
          creationLineageSql(true, true) +
            `SELECT id FROM identified WHERE historyKey=(SELECT historyKey FROM identified WHERE id=?)` +
            (command.before === undefined ? "" : " AND createdAt<?"),
          [
            this.context.namespace,
            owner,
            task.spec.projectId,
            task.spec.id,
            ...(command.before === undefined ? [] : [command.before]),
          ],
        );
        for (let offset = 0; offset < rows.length; offset += 250) {
          const batch = rows.slice(offset, offset + 250);
          const changed = await this.context.sql.unsafe(
            `INSERT IGNORE INTO panda_force_creation_history_hidden(namespace,id,owner) VALUES ${batch.map(() => "(?,?,?)").join(",")}`,
            batch.flatMap((row: Record<string, unknown>) => [this.context.namespace, row.id, owner]),
          );
          hidden += mysqlInteger(changed.affectedRows);
        }
      } else {
        const changed = await this.context.sql.unsafe(
          `INSERT IGNORE INTO panda_force_creation_history_hidden(namespace,id,owner) SELECT namespace,id,owner FROM panda_force_creation_tasks WHERE namespace=? AND owner=?` +
            (command.before === undefined ? "" : " AND createdAt<?"),
          [this.context.namespace, owner, ...(command.before === undefined ? [] : [command.before])],
        );
        hidden = mysqlInteger(changed.affectedRows);
      }
      const result = { id: command.id, hidden };
      await this.context
        .sql`INSERT INTO panda_force_creation_history_actions(namespace,id,owner,request,result,createdAt) VALUES(${this.context.namespace},${command.id},${owner},${signature},${stableJson(result)},${now})`;
      return result;
    });
  }
  async list(owner: string, projectId?: string): Promise<CreationHistoryTask[]> {
    if (projectId !== undefined) creationId(projectId);
    const rows = await this.context.sql.unsafe(
      creationLineageSql(true, projectId !== undefined) +
        `, ranked AS (
      SELECT t.*,ROW_NUMBER() OVER(PARTITION BY projectId,historyKey ORDER BY ${creationHeadOrder}) AS historyRank
      FROM identified t WHERE NOT EXISTS(SELECT 1 FROM panda_force_creation_history_hidden h WHERE h.namespace=t.namespace AND h.id=t.id AND h.owner=t.owner)
    ) SELECT * FROM (
      SELECT original.*,ranked.creationRootId,ranked.creationCreatedAt,ranked.creationRounds FROM ranked
      JOIN panda_force_creation_tasks original ON original.namespace=ranked.namespace AND original.id=ranked.id AND original.owner=ranked.owner WHERE historyRank=1
    ) heads ORDER BY ${projectId === undefined ? creationHeadOrder : "createdAt DESC,id DESC"} LIMIT ${projectId === undefined ? 50 : 20}`,
      projectId === undefined ? [this.context.namespace, owner] : [this.context.namespace, owner, projectId],
    );
    return rows.map((row: Record<string, unknown>) => creationHistoryTask(mysqlCreationLineageRow(row)));
  }
  async rounds(owner: string, id: string, cursor?: string) {
    const task = await this.get(owner, id),
      before = creationRoundCursor(cursor);
    const rows = await this.context.sql.unsafe(
      creationLineageSql(true, true) +
        `, conversation AS (
      SELECT t.*,FIRST_VALUE(id) OVER(ORDER BY ${creationHeadOrder}) AS latestTaskId FROM identified t
      WHERE historyKey=(SELECT historyKey FROM identified WHERE id=?)
    ) SELECT * FROM conversation` +
        (before ? " WHERE (createdAt<? OR (createdAt=? AND id<?))" : "") +
        " ORDER BY createdAt DESC,id DESC LIMIT 11",
      [this.context.namespace, owner, task.spec.projectId, id, ...(before ? [before.at, before.at, before.id] : [])],
    );
    return creationRoundPage(rows.map((row: Record<string, unknown>) => mysqlCreationRoundRow(row)));
  }
  async nextOutput(now: number) {
    creationInteger(now);
    const rows = await this.context
      .sql`SELECT * FROM panda_force_creation_tasks WHERE namespace=${this.context.namespace} AND state='committing' AND artifact IS NULL AND (failure IS NULL OR (failure='writeUnavailable' AND updatedAt<=${now - 5000})) ORDER BY updatedAt,id LIMIT 1`;
    return rows.length ? creationTask(mysqlCreationTaskRow(rows[0])) : null;
  }
}
