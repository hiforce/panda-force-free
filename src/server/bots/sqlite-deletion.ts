import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { BotTask } from "../../shared/bots/contracts.js";
import { botDeleteInput, callbackInFlight, deleteResult } from "./deletion.js";

export function deleteSQLiteBots(db: Database, owner: string, value: unknown, botId?: string) {
  const keys = botDeleteInput(value, botId !== undefined);
  return db
    .transaction(() => {
      const result = deleteResult(keys.length);
      for (const key of keys) {
        let row =
          botId === undefined
            ? db
                .query<{ id: string; status: string; data: string }, [string, string]>(
                  "SELECT id,status,data FROM bot_tasks WHERE owner=? AND id=?",
                )
                .get(owner, key)
            : db
                .query<{ id: string; status: string; data: string }, [string, string, string]>(
                  "SELECT id,status,data FROM bot_tasks WHERE owner=? AND botId=? AND idem=?",
                )
                .get(owner, botId, key);
        if (!row && botId !== undefined) {
          db.query(
            "INSERT INTO bot_tasks(id,owner,botId,idem,fingerprint,status,data) VALUES(?,?,?,?,'','deleted','{}')",
          ).run(randomUUID(), owner, botId, key);
          result.alreadyDeleted++;
          continue;
        }
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
        db.query(
          "UPDATE bot_tasks SET status='deleted',data='{}',lease=NULL,leaseUntil=NULL WHERE owner=? AND id=?",
        ).run(owner, row.id);
        db.query("DELETE FROM bot_events WHERE taskId=?").run(row.id);
        if (task.status === "running") result.interrupted.push(row.id);
        result.deleted++;
      }
      return result;
    })
    .immediate();
}
