import { SQLiteBotProfiles } from "./sqlite-profiles.js";
import { SQLiteBotKeys } from "./sqlite-keys.js";
import { SQLiteBotQueries } from "./sqlite-queries.js";
import { retryFailedSQLiteBots } from "./sqlite-recovery.js";

import { changeBotTaskLifecycle } from "./task-lifecycle.js";
import { taskStateExpression } from "./queue-query.js";
import { botTaskData } from "./task-record.js";
import { applyBotReview, botTaskActions, botTaskAction, botHasCallbackDecision } from "../../shared/bots/actions.js";
import { botTaskView, botCallbackStatus } from "../../shared/bots/task-state.js";
import { stableJson } from "../../shared/stable-json.js";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import {
  BotError,
  botText,
  botTaskInput,
  type BotConfig,
  type BotTask,
  type BotTaskInput,
  type BotReviewAnswer,
} from "../../shared/bots/contracts.js";
import { BotAvatars } from "./avatars.js";

type Row = { data: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class BotStore {
  readonly db: Database;
  readonly avatars: BotAvatars;
  private readonly sessions = new Set<string>();
  private readonly profiles: SQLiteBotProfiles;
  private readonly credentials: SQLiteBotKeys;
  private readonly queries: SQLiteBotQueries;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const target of [dirname(path), path, path + "-wal", path + "-shm"]) {
        const info = lstatSync(target, { throwIfNoEntry: false });
        if (info?.isSymbolicLink()) throw new BotError("unavailable", 503);
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, owner TEXT NOT NULL, code TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,code));
      CREATE TABLE IF NOT EXISTS bot_keys(id TEXT PRIMARY KEY, owner TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, botId TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, lease TEXT, leaseUntil INTEGER, data TEXT NOT NULL, UNIQUE(owner,botId,idem));
      CREATE INDEX IF NOT EXISTS bots_session ON bots(json_extract(data, '$.sessionId'));
      CREATE INDEX IF NOT EXISTS bot_tasks_queue ON bot_tasks(status,botId);
      CREATE INDEX IF NOT EXISTS bot_tasks_fifo ON bot_tasks(status);
      CREATE INDEX IF NOT EXISTS bot_tasks_manual_queue ON bot_tasks(botId) WHERE status='queued' AND json_extract(data,'$.decision')='discard';
      CREATE INDEX IF NOT EXISTS bot_tasks_action_queue ON bot_tasks(botId) WHERE status='queued' AND json_extract(data,'$.decision') IS NOT NULL AND json_extract(data,'$.decision')!='review';
      CREATE TABLE IF NOT EXISTS bot_events(taskId TEXT NOT NULL, createdAt INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_events_task ON bot_events(taskId);
      CREATE INDEX IF NOT EXISTS bot_tasks_owner ON bot_tasks(owner);
      CREATE INDEX IF NOT EXISTS bot_tasks_owner_status ON bot_tasks(owner,status);
      CREATE INDEX IF NOT EXISTS bot_tasks_lease ON bot_tasks(status,leaseUntil);
      CREATE TABLE IF NOT EXISTS bot_sessions(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bot_schema_meta(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bot_settings(owner TEXT PRIMARY KEY, retentionDays INTEGER NOT NULL CHECK(retentionDays BETWEEN 1 AND 365));
      CREATE TABLE IF NOT EXISTS bot_recoveries(owner TEXT NOT NULL,id TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS bot_tasks_retention ON bot_tasks(json_extract(data,'$.updatedAt')) WHERE status IN ('kept','discarded','canceled','callback_failed');
      CREATE INDEX IF NOT EXISTS bot_tasks_action_retention ON bot_tasks(json_extract(data,'$.updatedAt')) WHERE status IN ('kept','discarded','completed','canceled','callback_failed');
      INSERT OR IGNORE INTO bot_sessions SELECT json_extract(data,'$.sessionId') FROM bots WHERE json_extract(data,'$.sessionId') IS NOT NULL;


    `);
    if (!this.db.query("SELECT 1 FROM bot_schema_meta WHERE id='session-history-v1'").get()) {
      this.db
        .transaction(() => {
          this.db.exec(
            "INSERT OR IGNORE INTO bot_sessions SELECT DISTINCT json_extract(data,'$.sessionId') FROM bot_tasks WHERE json_extract(data,'$.sessionId') IS NOT NULL",
          );
          this.db.query("INSERT OR IGNORE INTO bot_schema_meta VALUES('session-history-v1')").run();
        })
        .immediate();
    }
    this.avatars = new BotAvatars(this.db);
    this.profiles = new SQLiteBotProfiles(this.db, this.avatars, this.sessions);
    this.credentials = new SQLiteBotKeys(this.db, this.profiles);
    this.queries = new SQLiteBotQueries(this.db);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS bot_tasks_owner_live_state_v2 ON bot_tasks(owner,(${taskStateExpression})) WHERE status!='deleted';`,
    );
    for (const row of this.db.query<{ id: string }, []>("SELECT id FROM bot_sessions").all()) this.sessions.add(row.id);
  }
  bots = (...args: Parameters<SQLiteBotProfiles["bots"]>) => this.profiles.bots(...args);
  bot = (...args: Parameters<SQLiteBotProfiles["bot"]>) => this.profiles.bot(...args);
  saveBot = (...args: Parameters<SQLiteBotProfiles["saveBot"]>) => this.profiles.saveBot(...args);
  createBot = (...args: Parameters<SQLiteBotProfiles["createBot"]>) => this.profiles.createBot(...args);
  updateBot = (...args: Parameters<SQLiteBotProfiles["updateBot"]>) => this.profiles.updateBot(...args);
  configureBot = (...args: Parameters<SQLiteBotProfiles["configureBot"]>) => this.profiles.configureBot(...args);
  keys = (...args: Parameters<SQLiteBotKeys["keys"]>) => this.credentials.keys(...args);
  issue = (...args: Parameters<SQLiteBotKeys["issue"]>) => this.credentials.issue(...args);
  revoke = (...args: Parameters<SQLiteBotKeys["revoke"]>) => this.credentials.revoke(...args);
  authenticate = (...args: Parameters<SQLiteBotKeys["authenticate"]>) => this.credentials.authenticate(...args);
  submit(bot: BotConfig, input: BotTaskInput, idem: string) {
    input = botTaskInput(input);
    botText(idem, 256);
    return this.db
      .transaction(() => {
        const current = this.bot(bot.owner, bot.id);
        for (const action of botTaskActions({ input }))
          if (action.callback && !current.callbackHosts.includes(new URL(action.callback.url).hostname))
            throw new BotError("callbackHostDenied", 403);
        const fingerprint = digest(stableJson(input));
        const previous = this.db
          .query<Row & { fingerprint: string; status: string }, [string, string, string]>(
            "SELECT data,fingerprint,status FROM bot_tasks WHERE owner=? AND botId=? AND idem=?",
          )
          .get(bot.owner, bot.id, idem);
        if (previous) {
          if (previous.status === "deleted") throw new BotError("taskDeleted", 409);
          if (previous.fingerprint !== fingerprint) throw new BotError("idempotencyConflict", 409);
          return { task: botTaskView(JSON.parse(previous.data) as BotTask), duplicate: true };
        }
        const n = this.db
          .query<{ n: number }, [string]>(
            "SELECT count(*) n FROM bot_tasks WHERE owner=? AND status IN ('queued','running')",
          )
          .get(bot.owner)!.n;
        if (n >= 1000) throw new BotError("queueFull", 429);
        const task: BotTask = {
          id: randomUUID(),
          owner: bot.owner,
          botId: bot.id,
          externalTaskId: input.externalTaskId,
          ...(input.title ? { title: input.title } : {}),
          status: "queued",
          input,
          decision: null,
          reason: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sessionId: null,
          runId: null,
        };
        this.db
          .query("INSERT INTO bot_tasks VALUES(?,?,?,?,?,?,NULL,NULL,?)")
          .run(task.id, task.owner, task.botId, idem, fingerprint, task.status, botTaskData(task));
        this.event(task.id, "queued", "Task accepted");
        return { task: botTaskView(task), duplicate: false };
      })
      .immediate();
  }
  tasks = (...args: Parameters<SQLiteBotQueries["tasks"]>) => this.queries.tasks(...args);
  retryFailed(owner: string, value: unknown) {
    return retryFailedSQLiteBots(this.db, owner, value);
  }
  taskSummaries = (...args: Parameters<SQLiteBotQueries["taskSummaries"]>) => this.queries.taskSummaries(...args);
  queue = (...args: Parameters<SQLiteBotQueries["queue"]>) => this.queries.queue(...args);
  task = (...args: Parameters<SQLiteBotQueries["task"]>) => this.queries.task(...args);
  event(id: string, kind: string, detail: string) {
    this.db.query("INSERT INTO bot_events VALUES(?,?,?,?)").run(id, Date.now(), kind, detail);
  }
  deleteTask(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const task = this.task(owner, id);
        if (task.status === "running") throw new BotError("taskRunning", 409);
        // Keep only submission identity and fingerprint so deletion cannot replay an external action.
        this.db
          .query("UPDATE bot_tasks SET status='deleted',data='{}',lease=NULL,leaseUntil=NULL WHERE owner=? AND id=?")
          .run(owner, id);
        this.db.query("DELETE FROM bot_events WHERE taskId=?").run(id);
      })
      .immediate();
  }
  events = (...args: Parameters<SQLiteBotQueries["events"]>) => this.queries.events(...args);
  claim(excludedBots: readonly string[] = []): { task: BotTask; bot: BotConfig; lease: string } | null {
    return this.db
      .transaction(() => {
        const now = Date.now();
        const expired = this.db
          .query<Row & { lease: string }, [number]>(
            "SELECT data,lease FROM bot_tasks WHERE status='running' AND leaseUntil<?",
          )
          .all(now);
        for (const r of expired) {
          const t: BotTask = JSON.parse(r.data);
          t.status = botHasCallbackDecision(t) ? "callback_unknown" : "review";
          t.reason = t.reason ?? "Execution interrupted; manual review required";
          if (t.status === "review") t.failure = "execution";
          t.updatedAt = now;
          this.db
            .query("UPDATE bot_tasks SET status=?,lease=NULL,leaseUntil=NULL,data=? WHERE id=?")
            .run(t.status, botTaskData(t), t.id);
          this.event(t.id, "recovered", t.status);
        }
        const row = this.db
          .query<Row, (string | number)[]>(
            `SELECT t.data FROM bots b JOIN bot_tasks t ON t.rowid=CASE WHEN json_extract(b.data,'$.active')=1 THEN
             (SELECT q.rowid FROM bot_tasks q WHERE q.status='queued' AND q.botId=b.id AND q.owner=b.owner ORDER BY q.rowid LIMIT 1)
             ELSE (SELECT q.rowid FROM bot_tasks q WHERE q.status='queued' AND q.botId=b.id AND q.owner=b.owner AND json_extract(q.data,'$.decision') IS NOT NULL AND json_extract(q.data,'$.decision')!='review' ORDER BY q.rowid LIMIT 1) END
           WHERE NOT EXISTS(SELECT 1 FROM bot_tasks r WHERE r.status='running' AND r.botId=b.id)
           ${excludedBots.length ? `AND b.id NOT IN (${excludedBots.map(() => "?").join(",")})` : ""}
           AND (COALESCE(json_extract(b.data,'$.executionRetryAt'),0)<=? OR (json_extract(t.data,'$.decision') IS NOT NULL AND json_extract(t.data,'$.decision')!='review'))
           ORDER BY t.rowid LIMIT 1`,
          )
          .get(...excludedBots, now);
        if (row) {
          const task: BotTask = JSON.parse(row.data),
            bot = this.bot(task.owner, task.botId),
            lease = randomUUID();
          task.status = "running";
          task.updatedAt = now;
          this.db
            .query("UPDATE bot_tasks SET status='running',lease=?,leaseUntil=?,data=? WHERE id=?")
            .run(lease, now + 30000, botTaskData(task), task.id);
          this.event(task.id, "running", "Processing started");
          return { task, bot, lease };
        }
        return null;
      })
      .immediate();
  }
  heartbeat(id: string, lease: string) {
    return (
      this.db
        .query("UPDATE bot_tasks SET leaseUntil=? WHERE id=? AND lease=? AND status='running' AND leaseUntil>=?")
        .run(Date.now() + 30000, id, lease, Date.now()).changes === 1
    );
  }
  deferExecution(task: BotTask, lease: string) {
    return this.db
      .transaction(() => {
        if (!this.heartbeat(task.id, lease)) throw new BotError("leaseLost", 409);
        const current = this.task(task.owner, task.id);
        if (current.botId !== task.botId) throw new BotError("leaseLost", 409);
        const bot = this.bot(task.owner, task.botId);
        bot.executionRetryAt = Date.now() + 300000;
        this.profiles.saveBot(bot);
        task.status = "queued";
        task.decision = null;
        task.reason = "modelRateLimited";
        delete task.failure;
        this.update(task, lease, true);
        this.event(task.id, "execution_deferred", "modelRateLimited");
      })
      .immediate();
  }
  update(task: BotTask, lease: string, final = false) {
    task.updatedAt = Date.now();
    task.callbackStatus = botCallbackStatus(task);
    const result = this.db
      .query(
        "UPDATE bot_tasks SET data=?,status=?,lease=CASE WHEN ? THEN NULL ELSE lease END,leaseUntil=CASE WHEN ? THEN NULL ELSE leaseUntil END WHERE id=? AND lease=? AND leaseUntil>=?",
      )
      .run(botTaskData(task), task.status, final ? 1 : 0, final ? 1 : 0, task.id, lease, Date.now());
    if (result.changes !== 1) throw new BotError("leaseLost", 409);
  }
  review(owner: string, id: string, answer: BotReviewAnswer | string) {
    return this.db
      .transaction(() => {
        const task = this.task(owner, id);
        const result = applyBotReview(task, answer);
        if (result.duplicate) return botTaskView(task);
        const callback = botTaskAction(task, task.decision)?.callback;
        if (callback) {
          if (!this.bot(owner, task.botId).callbackHosts.includes(new URL(callback.url).hostname))
            throw new BotError("callbackHostDenied", 403);
        }
        task.updatedAt = Date.now();
        this.db.query("UPDATE bot_tasks SET data=?,status=? WHERE id=?").run(botTaskData(task), task.status, id);
        this.event(id, "manual", result.detail);
        return botTaskView(task);
      })
      .immediate();
  }
  retention(owner: string) {
    return {
      days:
        this.db
          .query<{ retentionDays: number }, [string]>("SELECT retentionDays FROM bot_settings WHERE owner=?")
          .get(owner)?.retentionDays ?? 5,
    };
  }
  setRetention(owner: string, days: unknown) {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365)
      throw new BotError("invalidInput");
    this.db
      .query(
        "INSERT INTO bot_settings VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET retentionDays=excluded.retentionDays",
      )
      .run(owner, days);
    return this.retention(owner);
  }
  cleanup(now = Date.now(), limit = 100) {
    return this.db
      .transaction(() => {
        const rows = this.db
          .query<{ id: string }, [number, number, number]>(
            `SELECT t.id FROM bot_tasks t LEFT JOIN bot_settings s ON s.owner=t.owner
        WHERE t.status IN ('kept','discarded','completed','canceled','callback_failed') AND json_extract(t.data,'$.updatedAt')<?
        AND json_extract(t.data,'$.updatedAt') < ? - COALESCE(s.retentionDays,5)*86400000
        ORDER BY json_extract(t.data,'$.updatedAt') LIMIT ?`,
          )
          .all(now - 86400000, now, Math.min(Math.max(1, limit), 100));
        for (const { id } of rows) {
          this.db.query("DELETE FROM bot_events WHERE taskId=?").run(id);
          this.db
            .query("UPDATE bot_tasks SET status='deleted',data='{}',lease=NULL,leaseUntil=NULL WHERE id=?")
            .run(id);
        }
        return rows.length;
      })
      .immediate();
  }
  lifecycle(owner: string, id: string, action: "cancel" | "suspend" | "resume") {
    return changeBotTaskLifecycle(this, owner, id, action);
  }
  hasSession = (...args: Parameters<SQLiteBotProfiles["hasSession"]>) => this.profiles.hasSession(...args);
  prepareSession = (...args: Parameters<SQLiteBotProfiles["prepareSession"]>) => this.profiles.prepareSession(...args);
  setSession = (...args: Parameters<SQLiteBotProfiles["setSession"]>) => this.profiles.setSession(...args);
  close() {
    this.db.close();
  }
}
