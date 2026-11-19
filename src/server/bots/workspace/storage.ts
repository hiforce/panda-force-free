import { BotError } from "../../../shared/bots/contracts.js";

export type BotWorkspaceKind =
  | "chat"
  | "chat-message"
  | "chat-receipt"
  | "cleanup"
  | "connection"
  | "integration"
  | "run"
  | "channel"
  | "channel-message"
  | "source-item"
  | "delivery"
  | "task-link"
  | "control";

export interface BotWorkspaceKey {
  kind: BotWorkspaceKind;
  id: string;
}
export interface BotWorkspaceRecord<T = unknown> extends BotWorkspaceKey {
  owner: string;
  botId: string;
  version: number;
  state: string;
  dueAt: number | null;
  expiresAt: number | null;
  data: T;
}
export type BotWorkspaceWrite = Omit<BotWorkspaceRecord, "owner" | "version">;
export interface BotWorkspaceBatch {
  checks: Array<BotWorkspaceKey & { version: number | null }>;
  activeBots?: string[];
  completedTasks?: Array<{ id: string; botId: string; updatedAt: number }>;
  puts?: BotWorkspaceWrite[];
  removes?: BotWorkspaceKey[];
}
export interface BotWorkspaceQuery {
  botId?: string;
  prefix?: string;
  after?: string;
  before?: string;
  descending?: boolean;
  state?: string;
  dueBefore?: number;
  expiresBefore?: number;
  liveAt?: number;
  limit?: number;
}

/** Batches are optimistic transactions: every mutation must carry its read version. */
export interface BotWorkspaceStorage {
  get<T>(owner: string, key: BotWorkspaceKey): Promise<BotWorkspaceRecord<T> | null>;
  list<T>(owner: string, kind: BotWorkspaceKind, query?: BotWorkspaceQuery): Promise<BotWorkspaceRecord<T>[]>;
  scan<T>(kind: BotWorkspaceKind, query: BotWorkspaceQuery): Promise<BotWorkspaceRecord<T>[]>;
  counts(owner: string, kind: BotWorkspaceKind): Promise<Record<string, Record<string, number>>>;
  batch(owner: string, value: BotWorkspaceBatch): Promise<boolean>;
}

export function validateWorkspaceBatch(value: BotWorkspaceBatch) {
  if (!value.checks.length || value.checks.length > 200) throw new BotError("invalidInput");
  if ((value.activeBots?.length ?? 0) > 100 || value.activeBots?.some((id) => !/^[a-f0-9-]{36}$/.test(id)))
    throw new BotError("invalidInput");
  if (
    (value.completedTasks?.length ?? 0) > 100 ||
    value.completedTasks?.some(
      (t) => !/^[a-f0-9-]{36}$/.test(t.id) || !/^[a-f0-9-]{36}$/.test(t.botId) || !Number.isSafeInteger(t.updatedAt),
    )
  )
    throw new BotError("invalidInput");
  const keys = new Set<string>();
  for (const key of value.checks) {
    if (
      !key.id ||
      key.id.length > 191 ||
      (key.version !== null && (!Number.isSafeInteger(key.version) || key.version < 1))
    )
      throw new BotError("invalidInput");
    const id = key.kind + ":" + key.id;
    if (keys.has(id)) throw new BotError("invalidInput");
    keys.add(id);
  }
  const mutations = new Set<string>();
  for (const item of [...(value.puts ?? []), ...(value.removes ?? [])]) {
    const id = item.kind + ":" + item.id;
    if (!keys.has(id) || mutations.has(id)) throw new BotError("invalidInput");
    mutations.add(id);
  }
  for (const item of value.puts ?? [])
    if (
      !item.botId ||
      item.botId.length > 36 ||
      item.state.length > 32 ||
      [item.dueAt, item.expiresAt].some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0)) ||
      Buffer.byteLength(JSON.stringify(item.data)) > 2 * 1024 * 1024
    )
      throw new BotError("invalidInput");
}

export function workspaceConditions(query: BotWorkspaceQuery, dialect: "sqlite" | "mysql") {
  const where: string[] = [],
    values: Array<string | number> = [];
  for (const [field, value] of [
    ["botId", query.botId],
    ["state", query.state],
  ] as const)
    if (value !== undefined) {
      where.push(field + "=?");
      values.push(value);
    }
  if (query.prefix !== undefined) {
    where.push("id LIKE ? ESCAPE '!' ");
    values.push(query.prefix.replace(/[!%_]/g, "!$&") + "%");
  }
  if (query.after) {
    where.push("id>?");
    values.push(query.after);
  }
  if (query.before) {
    where.push("id<?");
    values.push(query.before);
  }
  for (const [field, value] of [
    ["dueAt", query.dueBefore],
    ["expiresAt", query.expiresBefore],
  ] as const)
    if (value !== undefined) {
      where.push(field + "<=?");
      values.push(value);
    }
  if (query.liveAt !== undefined) {
    where.push("(expiresAt IS NULL OR expiresAt>?)");
    values.push(query.liveAt);
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new BotError("invalidInput");
  return {
    where,
    values,
    limit,
    order:
      (dialect === "mysql" ? "id COLLATE utf8mb4_bin" : "id COLLATE BINARY") + (query.descending ? " DESC" : " ASC"),
  };
}

export function workspaceRow<T>(row: Record<string, unknown>): BotWorkspaceRecord<T> {
  return {
    owner: String(row.owner),
    kind: row.kind as BotWorkspaceKind,
    id: String(row.id),
    botId: String(row.botId),
    version: Number(row.version),
    state: String(row.state),
    dueAt: row.dueAt === null ? null : Number(row.dueAt),
    expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
    data: JSON.parse(String(row.data)) as T,
  };
}
