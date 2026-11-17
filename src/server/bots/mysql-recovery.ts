import { botCanRetryExecution } from "../../shared/bots/recovery.js";
import type { BotBulkRetryResult, BotTask } from "../../shared/bots/contracts.js";
import type { MySQLBotContext } from "./mysql-context.js";
import { botRecoveryInput, botRecoveryReplay } from "./recovery-input.js";
import { transitionBotTask } from "./task-lifecycle.js";
import { botTaskData } from "./task-record.js";
import { botCallbackStatus } from "../../shared/bots/task-state.js";

export function retryFailedMySQLBots(
  context: MySQLBotContext,
  owner: string,
  value: unknown,
  maxPendingPerOwner: number,
): Promise<BotBulkRetryResult> {
  const request = botRecoveryInput(value);
  return context.transaction(async (sql) => {
    await context.lock(sql, "queue");
    const previous =
      await sql`SELECT signature,result FROM panda_force_bot_recoveries WHERE owner=${owner} AND id=${request.id} FOR UPDATE`;
    if (previous.length) return botRecoveryReplay(previous[0], request.signature);
    const pending = Number(
      (
        await sql`SELECT COUNT(*) n FROM panda_force_bot_tasks WHERE owner=${owner} AND status IN ('queued','running')`
      )[0].n,
    );
    let queued = 0;
    for (const id of request.taskIds) {
      const rows =
        await sql`SELECT data FROM panda_force_bot_tasks WHERE owner=${owner} AND id=${id} AND status!='deleted' FOR UPDATE`;
      if (!rows.length) continue;
      const task = JSON.parse(rows[0].data) as BotTask;
      if (!botCanRetryExecution(task) || pending + queued >= maxPendingPerOwner) continue;
      const next = transitionBotTask(task, "resume");
      next.callbackStatus = botCallbackStatus(next);
      await sql`UPDATE panda_force_bot_tasks SET status='queued',state='created',failure=NULL,updatedAt=${next.updatedAt},data=${botTaskData(next)},lease=NULL,leaseUntil=NULL WHERE owner=${owner} AND id=${id}`;
      await sql`INSERT INTO panda_force_bot_events(taskId,createdAt,kind,detail) VALUES(${id},${Date.now()},'resume','Execution retry requested by its owner')`;
      await sql`UPDATE panda_force_bots SET data=JSON_REMOVE(data,'$.executionRetryAt') WHERE owner=${owner} AND id=${task.botId}`;
      queued++;
    }
    const result = {
      id: request.id,
      requested: request.taskIds.length,
      queued,
      skipped: request.taskIds.length - queued,
    };
    await sql`INSERT INTO panda_force_bot_recoveries(owner,id,signature,result) VALUES(${owner},${request.id},${request.signature},${JSON.stringify(result)})`;
    return result;
  });
}
