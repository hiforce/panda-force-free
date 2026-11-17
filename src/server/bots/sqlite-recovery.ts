import type { Database } from "bun:sqlite";
import { botCanRetryExecution } from "../../shared/bots/recovery.js";
import type { BotTask, BotBulkRetryResult } from "../../shared/bots/contracts.js";
import { botRecoveryInput, botRecoveryReplay } from "./recovery-input.js";
import { transitionBotTask } from "./task-lifecycle.js";
import { botTaskData } from "./task-record.js";

export function retryFailedSQLiteBots(db: Database, owner: string, value: unknown): BotBulkRetryResult {
  const request = botRecoveryInput(value);
  return db
    .transaction(() => {
      const previous = db
        .query<{ signature: string; result: string }, [string, string]>(
          "SELECT signature,result FROM bot_recoveries WHERE owner=? AND id=?",
        )
        .get(owner, request.id);
      if (previous) return botRecoveryReplay(previous, request.signature);
      let queued = 0;
      const pending = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM bot_tasks WHERE owner=? AND status IN ('queued','running')",
        )
        .get(owner)!.n;
      for (const id of request.taskIds) {
        const row = db
          .query<{ data: string }, [string, string]>(
            "SELECT data FROM bot_tasks WHERE owner=? AND id=? AND status!='deleted'",
          )
          .get(owner, id);
        if (!row) continue;
        const task = JSON.parse(row.data) as BotTask;
        if (!botCanRetryExecution(task) || pending + queued >= 1000) continue;
        const next = transitionBotTask(task, "resume");
        db.query("UPDATE bot_tasks SET status='queued',data=?,lease=NULL,leaseUntil=NULL WHERE owner=? AND id=?").run(
          botTaskData(next),
          owner,
          id,
        );
        db.query("INSERT INTO bot_events VALUES(?,?,?,?)").run(
          id,
          Date.now(),
          "resume",
          "Execution retry requested by its owner",
        );
        // Explicit recovery after the provider was repaired allows an immediate probe.
        db.query("UPDATE bots SET data=json_remove(data,'$.executionRetryAt') WHERE owner=? AND id=?").run(
          owner,
          task.botId,
        );
        queued++;
      }
      const result = {
        id: request.id,
        requested: request.taskIds.length,
        queued,
        skipped: request.taskIds.length - queued,
      };
      db.query("INSERT INTO bot_recoveries VALUES(?,?,?,?)").run(
        owner,
        request.id,
        request.signature,
        JSON.stringify(result),
      );
      return result;
    })
    .immediate();
}
