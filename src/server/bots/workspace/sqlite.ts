import type { Database } from "bun:sqlite";
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

export const botWorkspaceSQLiteSchema = `
  CREATE TABLE IF NOT EXISTS bot_workspace_records(
    owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,botId TEXT NOT NULL,
    version INTEGER NOT NULL,state TEXT NOT NULL,dueAt INTEGER,expiresAt INTEGER,data TEXT NOT NULL,
    PRIMARY KEY(owner,kind,id));
  CREATE INDEX IF NOT EXISTS bot_workspace_bot ON bot_workspace_records(owner,kind,botId,id);
  CREATE INDEX IF NOT EXISTS bot_workspace_due ON bot_workspace_records(kind,state,dueAt);
  CREATE INDEX IF NOT EXISTS bot_workspace_expiry ON bot_workspace_records(kind,expiresAt);
`;

/** Shares the Bot database; no asynchronous work is performed inside a SQLite transaction. */
export class SQLiteBotWorkspaceStorage implements BotWorkspaceStorage {
  constructor(private db: Database) {
    db.exec(botWorkspaceSQLiteSchema);
  }
  async get<T>(owner: string, key: BotWorkspaceKey) {
    const row = this.db
      .query<Record<string, unknown>, [string, string, string]>(
        "SELECT * FROM bot_workspace_records WHERE owner=? AND kind=? AND id=?",
      )
      .get(owner, key.kind, key.id);
    return row ? workspaceRow<T>(row) : null;
  }
  async list<T>(owner: string, kind: BotWorkspaceKind, query: BotWorkspaceQuery = {}) {
    const parsed = workspaceConditions(query, "sqlite");
    return this.db
      .query<Record<string, unknown>, (string | number)[]>(
        `SELECT * FROM bot_workspace_records WHERE owner=? AND kind=?${parsed.where.length ? " AND " + parsed.where.join(" AND ") : ""} ORDER BY ${parsed.order} LIMIT ?`,
      )
      .all(owner, kind, ...parsed.values, parsed.limit)
      .map((row) => workspaceRow<T>(row));
  }
  async scan<T>(kind: BotWorkspaceKind, query: BotWorkspaceQuery) {
    const parsed = workspaceConditions(query, "sqlite");
    return this.db
      .query<Record<string, unknown>, (string | number)[]>(
        `SELECT * FROM bot_workspace_records WHERE kind=?${parsed.where.length ? " AND " + parsed.where.join(" AND ") : ""} ORDER BY ${query.dueBefore === undefined && query.expiresBefore === undefined ? parsed.order : "dueAt,id"} LIMIT ?`,
      )
      .all(kind, ...parsed.values, parsed.limit)
      .map((row) => workspaceRow<T>(row));
  }
  async counts(owner: string, kind: BotWorkspaceKind) {
    const result: Record<string, Record<string, number>> = {};
    for (const row of this.db
      .query<{ botId: string; state: string; n: number }, [string, string]>(
        "SELECT botId,state,COUNT(*) n FROM bot_workspace_records WHERE owner=? AND kind=? GROUP BY botId,state",
      )
      .all(owner, kind))
      (result[row.botId] ??= {})[row.state] = row.n;
    return result;
  }
  async batch(owner: string, value: BotWorkspaceBatch) {
    validateWorkspaceBatch(value);
    return this.db
      .transaction(() => {
        for (const id of new Set((value.puts ?? []).map((item) => item.botId).filter((id) => id !== "connections"))) {
          if (this.db.query("SELECT 1 FROM bot_schema_meta WHERE id=?").get("deleted-profile:" + owner + ":" + id))
            return false;
        }
        for (const id of value.activeBots ?? []) {
          if (
            !this.db
              .query("SELECT 1 FROM bots WHERE owner=? AND id=? AND json_extract(data,'$.active')=1")
              .get(owner, id)
          )
            return false;
        }
        for (const task of value.completedTasks ?? []) {
          const row = this.db
            .query<{ data: string }, [string, string, string]>(
              "SELECT data FROM bot_tasks WHERE owner=? AND botId=? AND id=? AND status='completed'",
            )
            .get(owner, task.botId, task.id);
          if (!row || JSON.parse(row.data).updatedAt !== task.updatedAt) return false;
        }
        for (const check of value.checks) {
          const row = this.db
            .query<{ version: number }, [string, string, string]>(
              "SELECT version FROM bot_workspace_records WHERE owner=? AND kind=? AND id=?",
            )
            .get(owner, check.kind, check.id);
          if ((row?.version ?? null) !== check.version) return false;
        }
        for (const item of value.puts ?? []) {
          const version = (value.checks.find((c) => c.kind === item.kind && c.id === item.id)!.version ?? 0) + 1;
          this.db
            .query(
              "INSERT INTO bot_workspace_records VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET botId=excluded.botId,version=excluded.version,state=excluded.state,dueAt=excluded.dueAt,expiresAt=excluded.expiresAt,data=excluded.data",
            )
            .run(
              owner,
              item.kind,
              item.id,
              item.botId,
              version,
              item.state,
              item.dueAt,
              item.expiresAt,
              JSON.stringify(item.data),
            );
        }
        for (const item of value.removes ?? [])
          this.db
            .query("DELETE FROM bot_workspace_records WHERE owner=? AND kind=? AND id=?")
            .run(owner, item.kind, item.id);
        return true;
      })
      .immediate();
  }
}
