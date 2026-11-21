import type { SQL } from "bun";
import { MySQLBotContext } from "../mysql-context.js";
import {
  validateWorkspaceBatch,
  workspaceConditions,
  workspaceRow,
  type BotWorkspaceBatch,
  type BotWorkspaceKey,
  type BotWorkspaceKind,
  type BotWorkspaceQuery,
  type BotWorkspaceStorage,
} from "./storage.js";

/** The owner lock makes missing-record checks and multi-record writes one transaction across peers. */
export class MySQLBotWorkspaceStorage implements BotWorkspaceStorage {
  constructor(private context: MySQLBotContext) {}
  get<T>(owner: string, key: BotWorkspaceKey) {
    return this.context.operation(async () => {
      const rows = await this.context
        .pool`SELECT * FROM panda_force_bot_workspace_records WHERE owner=${owner} AND kind=${key.kind} AND id=${key.id}`;
      return rows.length ? workspaceRow<T>(rows[0]) : null;
    });
  }
  list<T>(owner: string, kind: BotWorkspaceKind, query: BotWorkspaceQuery = {}) {
    return this.read<T>(["owner=?", "kind=?"], [owner, kind], query, false);
  }
  scan<T>(kind: BotWorkspaceKind, query: BotWorkspaceQuery) {
    return this.read<T>(["kind=?"], [kind], query, true);
  }
  counts(owner: string, kind: BotWorkspaceKind) {
    return this.context.operation(async () => {
      const result: Record<string, Record<string, number>> = {};
      for (const row of await this.context
        .pool`SELECT botId,state,COUNT(*) n FROM panda_force_bot_workspace_records WHERE owner=${owner} AND kind=${kind} GROUP BY botId,state`)
        (result[row.botId] ??= {})[row.state] = Number(row.n);
      return result;
    });
  }
  private read<T>(where: string[], values: (string | number)[], query: BotWorkspaceQuery, scan: boolean) {
    const parsed = workspaceConditions(query, "mysql");
    return this.context.operation(async () => {
      const rows = await this.context.pool.unsafe(
        `SELECT * FROM panda_force_bot_workspace_records WHERE ${[...where, ...parsed.where].join(" AND ")} ORDER BY ${scan && (query.dueBefore !== undefined || query.expiresBefore !== undefined) ? "dueAt,id" : parsed.order} LIMIT ?`,
        [...values, ...parsed.values, parsed.limit],
      );
      return rows.map((row: Record<string, unknown>) => workspaceRow<T>(row));
    });
  }
  batch(owner: string, value: BotWorkspaceBatch) {
    validateWorkspaceBatch(value);
    return this.context.transaction(async (sql: SQL) => {
      await this.context.lock(sql, "workspace:" + owner);
      for (const id of [
        ...new Set((value.puts ?? []).map((item) => item.botId).filter((id) => id !== "connections")),
      ].sort()) {
        if ((await sql`SELECT name FROM panda_force_bot_control WHERE name=${"deleted-profile:" + id}`).length)
          return false;
      }
      for (const id of value.activeBots ?? []) {
        const rows = await sql`SELECT data FROM panda_force_bots WHERE owner=${owner} AND id=${id} FOR UPDATE`;
        if (!rows.length || !JSON.parse(String(rows[0].data)).active) return false;
      }
      for (const task of value.completedTasks ?? []) {
        const rows =
          await sql`SELECT updatedAt FROM panda_force_bot_tasks WHERE owner=${owner} AND botId=${task.botId} AND id=${task.id} AND status='completed' FOR UPDATE`;
        if (!rows.length || Number(rows[0].updatedAt) !== task.updatedAt) return false;
      }
      for (const check of value.checks) {
        const rows =
          await sql`SELECT version FROM panda_force_bot_workspace_records WHERE owner=${owner} AND kind=${check.kind} AND id=${check.id} FOR UPDATE`;
        if ((rows.length ? Number(rows[0].version) : null) !== check.version) return false;
      }
      for (const item of value.puts ?? []) {
        const version = (value.checks.find((c) => c.kind === item.kind && c.id === item.id)!.version ?? 0) + 1;
        await sql`INSERT INTO panda_force_bot_workspace_records(owner,kind,id,botId,version,state,dueAt,expiresAt,data)
          VALUES(${owner},${item.kind},${item.id},${item.botId},${version},${item.state},${item.dueAt},${item.expiresAt},${JSON.stringify(item.data)})
          ON DUPLICATE KEY UPDATE botId=VALUES(botId),version=VALUES(version),state=VALUES(state),dueAt=VALUES(dueAt),expiresAt=VALUES(expiresAt),data=VALUES(data)`;
      }
      for (const item of value.removes ?? [])
        await sql`DELETE FROM panda_force_bot_workspace_records WHERE owner=${owner} AND kind=${item.kind} AND id=${item.id}`;
      return true;
    });
  }
}
