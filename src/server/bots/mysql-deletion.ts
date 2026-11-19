import { randomUUID } from "node:crypto";
import type { BotTask } from "../../shared/bots/contracts.js";
import type { MySQLBotContext } from "./mysql-context.js";
import { botDeleteInput, callbackInFlight, deleteResult } from "./deletion.js";

export function deleteMySQLBots(context: MySQLBotContext, owner: string, value: unknown, botId?: string) {
  const keys = botDeleteInput(value, botId !== undefined);
  return context.transaction(async (sql) => {
    const result = deleteResult(keys.length);
    for (const key of keys) {
      if (botId !== undefined) {
        // The unique submission key arbitrates delete-before-submit and concurrent submission.
        // A newer business instance uses another key and remains independent.
        await sql`INSERT INTO panda_force_bot_tasks(id,owner,botId,idem,fingerprint,status,state,externalTaskId,title,summary,createdAt,updatedAt,data) VALUES(${randomUUID()},${owner},${botId},${key},'','deleted','canceled','',NULL,'',0,0,'{}') ON DUPLICATE KEY UPDATE id=id`;
      }
      const rows =
        botId === undefined
          ? await sql`SELECT id,status,data FROM panda_force_bot_tasks WHERE owner=${owner} AND id=${key} FOR UPDATE`
          : await sql`SELECT id,status,data FROM panda_force_bot_tasks WHERE owner=${owner} AND botId=${botId} AND idem=${key} FOR UPDATE`;
      const row = rows[0];
      if (!row) {
        result.blocked.push({ id: key, code: "notFound" });
        continue;
      }
      if (row.status === "deleted") {
        result.alreadyDeleted++;
        continue;
      }
      const task = JSON.parse(row.data) as BotTask;
      if (callbackInFlight(task)) {
        result.blocked.push({ id: key, code: "callbackInFlight" });
        continue;
      }
      await sql`DELETE FROM panda_force_bot_events WHERE taskId=${row.id}`;
      await sql`UPDATE panda_force_bot_tasks SET status='deleted',state='canceled',lease=NULL,leaseUntil=NULL,data='{}',externalTaskId='',title=NULL,summary='',decision=NULL,actionId=NULL,failure=NULL,createdAt=0,updatedAt=0 WHERE owner=${owner} AND id=${row.id}`;
      if (task.status === "running") result.interrupted.push(row.id);
      result.deleted++;
    }
    return result;
  });
}
