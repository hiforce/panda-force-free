import type { Database } from "bun:sqlite";
import { BotError } from "../../shared/bots/contracts.js";
import type { MySQLBotContext } from "./mysql-context.js";

function remainingGrant(data: string, botId: string) {
  const key = JSON.parse(data);
  key.botIds = key.botIds.filter((id: string) => id !== botId);
  if (!key.botIds.length) key.revokedAt ??= Date.now();
  return JSON.stringify(key);
}
const busyTasks = ["queued", "running", "callback_unknown"];
const busyWorkspace = (kind: string, state: string) =>
  (kind === "integration" && state === "enabled") ||
  (kind === "cleanup" && ["pending", "blocked", "running"].includes(state)) ||
  (["chat", "run", "delivery"].includes(kind) &&
    ["queued", "running", "collecting", "processing", "dispatching", "delivering", "unknown"].includes(state));

/** Delete a stopped assistant atomically; external calls with uncertain outcomes require reconciliation first. */
export function deleteSQLiteProfile(db: Database, owner: string, id: string) {
  return db
    .transaction(() => {
      if (!db.query("SELECT 1 FROM bots WHERE owner=? AND id=?").get(owner, id)) throw new BotError("notFound", 404);
      const tasks = db
        .query<{ status: string }, [string, string]>("SELECT status FROM bot_tasks WHERE owner=? AND botId=?")
        .all(owner, id);
      const workspace = db
        .query<{ kind: string; state: string }, [string, string]>(
          "SELECT kind,state FROM bot_workspace_records WHERE owner=? AND botId=?",
        )
        .all(owner, id);
      if (tasks.some((t) => busyTasks.includes(t.status)) || workspace.some((r) => busyWorkspace(r.kind, r.state)))
        throw new BotError("botBusy", 409);
      for (const key of db
        .query<{ id: string; data: string }, [string]>("SELECT id,data FROM bot_keys WHERE owner=?")
        .all(owner)) {
        if (JSON.parse(key.data).botIds.includes(id))
          db.query("UPDATE bot_keys SET data=? WHERE owner=? AND id=?").run(
            remainingGrant(key.data, id),
            owner,
            key.id,
          );
      }
      db.query("DELETE FROM bot_events WHERE taskId IN (SELECT id FROM bot_tasks WHERE owner=? AND botId=?)").run(
        owner,
        id,
      );
      db.query("DELETE FROM bot_tasks WHERE owner=? AND botId=?").run(owner, id);
      db.query("DELETE FROM bot_workspace_records WHERE owner=? AND botId=?").run(owner, id);
      db.query("INSERT OR IGNORE INTO bot_schema_meta(id) VALUES(?)").run("deleted-profile:" + owner + ":" + id);
      db.query("DELETE FROM bots WHERE owner=? AND id=?").run(owner, id);
      db.query(
        "DELETE FROM bot_avatars WHERE owner=? AND id NOT IN (SELECT json_extract(data,'$.avatar.id') FROM bots WHERE owner=? AND json_extract(data,'$.avatar.type')='image')",
      ).run(owner, owner);
      return { ok: true };
    })
    .immediate();
}

export function deleteMySQLProfile(context: MySQLBotContext, owner: string, id: string) {
  return context.transaction(async (sql) => {
    await context.lock(sql, "workspace:" + owner);
    await context.lock(sql, "owner:" + owner);
    const bots = await sql`SELECT id FROM panda_force_bots WHERE owner=${owner} AND id=${id} FOR UPDATE`;
    if (!bots.length) throw new BotError("notFound", 404);
    const tasks = await sql`SELECT status FROM panda_force_bot_tasks WHERE owner=${owner} AND botId=${id} FOR UPDATE`;
    const workspace =
      await sql`SELECT kind,state FROM panda_force_bot_workspace_records WHERE owner=${owner} AND botId=${id} FOR UPDATE`;
    if (
      tasks.some((t: { status: string }) => busyTasks.includes(t.status)) ||
      workspace.some((r: { kind: string; state: string }) => busyWorkspace(r.kind, r.state))
    )
      throw new BotError("botBusy", 409);
    const keys = await sql`SELECT id,data FROM panda_force_bot_keys WHERE owner=${owner} FOR UPDATE`;
    for (const key of keys)
      if (JSON.parse(key.data).botIds.includes(id))
        await sql`UPDATE panda_force_bot_keys SET data=${remainingGrant(key.data, id)} WHERE owner=${owner} AND id=${key.id}`;
    await sql`DELETE e FROM panda_force_bot_events e JOIN panda_force_bot_tasks t ON e.taskId=t.id WHERE t.owner=${owner} AND t.botId=${id}`;
    await sql`DELETE FROM panda_force_bot_tasks WHERE owner=${owner} AND botId=${id}`;
    await sql`DELETE FROM panda_force_bot_workspace_records WHERE owner=${owner} AND botId=${id}`;
    await sql`INSERT INTO panda_force_bot_control(name,value) VALUES(${"deleted-profile:" + id},${owner}) ON DUPLICATE KEY UPDATE value=VALUES(value)`;
    await sql`DELETE FROM panda_force_bots WHERE owner=${owner} AND id=${id}`;
    await sql`DELETE a FROM panda_force_bot_avatars a LEFT JOIN panda_force_bots b ON b.owner=a.owner AND JSON_UNQUOTE(JSON_EXTRACT(b.data,'$.avatar.type'))='image' AND JSON_UNQUOTE(JSON_EXTRACT(b.data,'$.avatar.id'))=a.id WHERE a.owner=${owner} AND b.id IS NULL`;
    return { ok: true };
  });
}
