import { duplicateBotRecord as duplicate } from "./mysql-context.js";
import { MySQLBotProfiles } from "./mysql-profiles.js";
import { MySQLBotKeys } from "./mysql-keys.js";
import { MySQLBotQueries } from "./mysql-queries.js";
import { MySQLBotWorkspaceStorage } from "./workspace/mysql.js";
import { MySQLBotContext } from "./mysql-context.js";
import { SQL } from "bun";
import { retryFailedMySQLBots } from "./mysql-recovery.js";
import { createHash, randomUUID } from "node:crypto";
import {
  BotError,
  botText,
  type BotConfig,
  botTaskInput,
  type BotReviewAnswer,
  type BotTask,
  type BotTaskInput,
} from "../../shared/bots/contracts.js";
import { botCallbackStatus, botTaskState, botTaskView } from "../../shared/bots/task-state.js";
import { stableJson } from "../../shared/stable-json.js";
import type { BotRepository } from "./repository.js";
import { taskSummary } from "./queue-query.js";
import { botTaskData } from "./task-record.js";
import { transitionBotTask } from "./task-lifecycle.js";
import { applyBotReview, botTaskActions, botTaskAction, botHasCallbackDecision } from "../../shared/bots/actions.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const parseTask = (data: string) => botTaskView(JSON.parse(data) as BotTask);
/** The original short decision column stays intact; caller-defined action codes have an additive projection. */
const actionId = (task: BotTask) =>
  task.input.actions?.some((action) => action.id === task.decision) ? task.decision : null;
const legacyDecision = (task: BotTask) => (actionId(task) ? null : task.decision);

/** Asynchronous MySQL repository. Schema upgrades and application-wide activation are owned by the database coordinator. */
export class MySQLBotStore implements BotRepository {
  private sessions = new Set<string>();
  readonly avatars = { read: (owner: string, id: string) => this.profiles.avatars.read(owner, id) };
  private readonly context: MySQLBotContext;
  private readonly profiles: MySQLBotProfiles;
  private readonly credentials: MySQLBotKeys;
  private readonly queries: MySQLBotQueries;
  readonly workspace: MySQLBotWorkspaceStorage;

  private constructor(
    private pool: SQL,
    private maxPendingPerOwner: number,
  ) {
    this.context = new MySQLBotContext(pool);
    this.profiles = new MySQLBotProfiles(this.context, this.sessions);
    this.credentials = new MySQLBotKeys(this.context, this.profiles);
    this.queries = new MySQLBotQueries(this.context);
    this.workspace = new MySQLBotWorkspaceStorage(this.context);
  }
  static async open(pool: SQL, options: { maxPendingPerOwner?: number } = {}) {
    const maxPendingPerOwner = options.maxPendingPerOwner ?? 10000;
    if (!Number.isSafeInteger(maxPendingPerOwner) || maxPendingPerOwner < 1) throw new Error("invalidBotQueueCapacity");
    const store = new MySQLBotStore(pool, maxPendingPerOwner);
    for (const row of await pool`SELECT id FROM panda_force_bot_sessions`) store.sessions.add(row.id);
    return store;
  }

  bots = (...args: Parameters<MySQLBotProfiles["bots"]>) => this.profiles.bots(...args);
  bot = (...args: Parameters<MySQLBotProfiles["bot"]>) => this.profiles.bot(...args);

  async saveBot(bot: BotConfig) {
    const result = await this.context.transaction(async (sql) => {
      await this.context.lock(sql, "owner:" + bot.owner);
      return this.profiles.put(sql, bot);
    });
    if (result.sessionId) this.sessions.add(result.sessionId);
    return result;
  }
  createBot = (...args: Parameters<MySQLBotProfiles["createBot"]>) => this.profiles.createBot(...args);
  updateBot = (...args: Parameters<MySQLBotProfiles["updateBot"]>) => this.profiles.updateBot(...args);
  configureBot = (...args: Parameters<MySQLBotProfiles["configureBot"]>) => this.profiles.configureBot(...args);
  keys = (...args: Parameters<MySQLBotKeys["keys"]>) => this.credentials.keys(...args);
  issue = (...args: Parameters<MySQLBotKeys["issue"]>) => this.credentials.issue(...args);
  revoke = (...args: Parameters<MySQLBotKeys["revoke"]>) => this.credentials.revoke(...args);
  authenticate = (...args: Parameters<MySQLBotKeys["authenticate"]>) => this.credentials.authenticate(...args);
  private async eventOn(sql: SQL, id: string, kind: string, detail: string) {
    await sql`INSERT INTO panda_force_bot_events(taskId,createdAt,kind,detail) VALUES(${id},${Date.now()},${kind},${detail})`;
  }
  event(id: string, kind: string, detail: string) {
    return this.context.operation(() => this.eventOn(this.pool, id, kind, detail));
  }
  private async write(sql: SQL, task: BotTask, lease: string | null, leaseUntil: number | null) {
    await sql`UPDATE panda_force_bot_tasks SET status=${task.status},state=${botTaskState(task)},decision=${legacyDecision(task)},actionId=${actionId(task)},failure=${task.failure ?? null},updatedAt=${task.updatedAt},data=${botTaskData(task)},lease=${lease},leaseUntil=${leaseUntil} WHERE id=${task.id}`;
  }
  submit(bot: BotConfig, input: BotTaskInput, idem: string) {
    input = botTaskInput(input);
    const fingerprint = digest(stableJson(input));
    const replay = (prior: { status: string; fingerprint: string; data: string }) => {
      if (prior.status === "deleted") throw new BotError("taskDeleted", 409);
      if (prior.fingerprint !== fingerprint) throw new BotError("idempotencyConflict", 409);
      return { task: parseTask(prior.data), duplicate: true };
    };
    return this.context
      .transaction(async (sql) => {
        botText(idem, 256);
        const current = await this.profiles.readBot(sql, bot.owner, bot.id);
        for (const action of botTaskActions({ input }))
          if (action.callback && !current.callbackHosts.includes(new URL(action.callback.url).hostname))
            throw new BotError("callbackHostDenied", 403);
        const prior =
          await sql`SELECT fingerprint,status,data FROM panda_force_bot_tasks WHERE owner=${bot.owner} AND botId=${bot.id} AND idem=${idem}`;
        if (prior.length) return replay(prior[0]);
        // This is an admission high-water mark, not a serialized owner counter. In-flight
        // transactions may overshoot it; pool bounds limit local concurrent admissions.
        // Task and event durability and idempotency remain transactional and exact.
        if (
          Number(
            (
              await sql`SELECT COUNT(*) n FROM panda_force_bot_tasks WHERE owner=${bot.owner} AND status IN ('queued','running')`
            )[0].n,
          ) >= this.maxPendingPerOwner
        )
          throw new BotError("queueFull", 429);
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
        const summary = taskSummary({ ...task, summary: input.input.text }).summary;
        await sql`INSERT INTO panda_force_bot_tasks(id,owner,botId,idem,fingerprint,status,state,lease,leaseUntil,externalTaskId,title,summary,decision,failure,createdAt,updatedAt,data) VALUES(${task.id},${task.owner},${task.botId},${idem},${fingerprint},'queued','created',NULL,NULL,${task.externalTaskId},${task.title ?? null},${summary},NULL,NULL,${task.createdAt},${task.updatedAt},${botTaskData(task)})`;
        await this.eventOn(sql, task.id, "queued", "Task accepted");
        return { task: botTaskView(task), duplicate: false };
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof BotError) || !duplicate(error.cause)) throw error;
        // A competing commit can win the unique idempotency key after our initial read.
        // Read outside the rolled-back transaction so its snapshot cannot hide the winner.
        return this.context.operation(async () => {
          const prior = await this
            .pool`SELECT fingerprint,status,data FROM panda_force_bot_tasks WHERE owner=${bot.owner} AND botId=${bot.id} AND idem=${idem}`;
          if (!prior.length) throw error;
          return replay(prior[0]);
        });
      });
  }
  tasks = (...args: Parameters<MySQLBotQueries["tasks"]>) => this.queries.tasks(...args);
  botCounts = (...args: Parameters<MySQLBotQueries["botCounts"]>) => this.queries.botCounts(...args);
  retryFailed(owner: string, value: unknown) {
    return retryFailedMySQLBots(this.context, owner, value, this.maxPendingPerOwner);
  }
  taskSummaries = (...args: Parameters<MySQLBotQueries["taskSummaries"]>) => this.queries.taskSummaries(...args);
  queue = (...args: Parameters<MySQLBotQueries["queue"]>) => this.queries.queue(...args);

  task = (...args: Parameters<MySQLBotQueries["task"]>) => this.queries.task(...args);
  events = (...args: Parameters<MySQLBotQueries["events"]>) => this.queries.events(...args);
  private async tombstone(sql: SQL, id: string) {
    await sql`DELETE FROM panda_force_bot_events WHERE taskId=${id}`;
    await sql`UPDATE panda_force_bot_tasks SET status='deleted',state='canceled',lease=NULL,leaseUntil=NULL,data='{}',externalTaskId='',title=NULL,summary='',decision=NULL,actionId=NULL,failure=NULL,createdAt=0,updatedAt=0 WHERE id=${id}`;
  }
  deleteTask(owner: string, id: string) {
    return this.context.transaction(async (sql) => {
      const task = await this.queries.readTask(sql, owner, id, true);
      if (task.status === "running") throw new BotError("taskRunning", 409);
      await this.tombstone(sql, id);
    });
  }
  claim(excludedBots: readonly string[] = []) {
    return this.context.transaction(async (sql) => {
      await this.context.lock(sql, "queue");
      const now = Date.now();
      const expired =
        await sql`SELECT data FROM panda_force_bot_tasks WHERE status='running' AND leaseUntil<${now} ORDER BY leaseUntil LIMIT 100 FOR UPDATE`;
      for (const row of expired) {
        const task = parseTask(row.data);
        task.status = botHasCallbackDecision(task) ? "callback_unknown" : "review";
        task.reason ??= "Execution interrupted; manual review required";
        if (task.status === "review") task.failure = "execution";
        task.updatedAt = now;
        await this.write(sql, task, null, null);
        await this.eventOn(sql, task.id, "recovered", task.status);
      }
      if (Number((await sql`SELECT COUNT(*) n FROM panda_force_bot_tasks WHERE status='running'`)[0].n) >= 4)
        return null;
      const rows = await sql.unsafe(
        `SELECT t.data FROM panda_force_bots b JOIN panda_force_bot_tasks t ON t.seq=CASE WHEN JSON_EXTRACT(b.data,'$.active')=TRUE THEN (SELECT q.seq FROM panda_force_bot_tasks q WHERE q.botId=b.id AND q.owner=b.owner AND q.status='queued' ORDER BY q.seq LIMIT 1) ELSE (SELECT q.seq FROM panda_force_bot_tasks q WHERE q.botId=b.id AND q.owner=b.owner AND q.status='queued' AND (q.actionId IS NOT NULL OR (q.decision IS NOT NULL AND q.decision!='review')) ORDER BY q.seq LIMIT 1) END WHERE NOT EXISTS(SELECT 1 FROM panda_force_bot_tasks r WHERE r.botId=b.id AND r.status='running') ${excludedBots.length ? `AND b.id NOT IN (${excludedBots.map(() => "?").join(",")})` : ""} AND (COALESCE(JSON_EXTRACT(b.data,'$.executionRetryAt'),0)<=? OR t.actionId IS NOT NULL OR (t.decision IS NOT NULL AND t.decision!='review')) ORDER BY t.seq LIMIT 1 FOR UPDATE`,
        [...excludedBots, now],
      );
      if (!rows.length) return null;
      const task = parseTask(rows[0].data),
        bot = await this.profiles.readBot(sql, task.owner, task.botId),
        lease = randomUUID();
      task.status = "running";
      task.updatedAt = now;
      await this.write(sql, task, lease, now + 30000);
      await this.eventOn(sql, task.id, "running", "Processing started");
      return { task, bot, lease };
    });
  }
  heartbeat(id: string, lease: string) {
    return this.context.operation(
      async () =>
        Number(
          (
            await this
              .pool`UPDATE panda_force_bot_tasks SET leaseUntil=${Date.now() + 30000} WHERE id=${id} AND lease=${lease} AND status='running' AND leaseUntil>=${Date.now()}`
          ).affectedRows,
        ) === 1,
    );
  }
  deferExecution(task: BotTask, lease: string) {
    return this.context.transaction(async (sql) => {
      const now = Date.now();
      const rows =
        await sql`SELECT id FROM panda_force_bot_tasks WHERE id=${task.id} AND owner=${task.owner} AND botId=${task.botId} AND status='running' AND lease=${lease} AND leaseUntil>=${now} FOR UPDATE`;
      if (!rows.length) throw new BotError("leaseLost", 409);
      const bot = await this.profiles.readBot(sql, task.owner, task.botId, true);
      bot.executionRetryAt = now + 300000;
      await this.profiles.put(sql, bot);
      task.status = "queued";
      task.decision = null;
      task.reason = "modelRateLimited";
      delete task.failure;
      task.updatedAt = now;
      task.callbackStatus = botCallbackStatus(task);
      await this.write(sql, task, null, null);
      await this.eventOn(sql, task.id, "execution_deferred", "modelRateLimited");
    });
  }
  update(task: BotTask, lease: string, final = false) {
    return this.context.operation(async () => {
      task.updatedAt = Date.now();
      task.callbackStatus = botCallbackStatus(task);
      const result = await this
        .pool`UPDATE panda_force_bot_tasks SET data=${botTaskData(task)},status=${task.status},state=${botTaskState(task)},decision=${legacyDecision(task)},actionId=${actionId(task)},failure=${task.failure ?? null},updatedAt=${task.updatedAt},lease=IF(${final},NULL,lease),leaseUntil=IF(${final},NULL,leaseUntil) WHERE id=${task.id} AND lease=${lease} AND leaseUntil>=${Date.now()}`;
      if (Number(result.affectedRows) !== 1) throw new BotError("leaseLost", 409);
    });
  }
  review(owner: string, id: string, answer: BotReviewAnswer | string) {
    return this.context.transaction(async (sql) => {
      const task = await this.queries.readTask(sql, owner, id, true);
      const result = applyBotReview(task, answer);
      if (result.duplicate) return botTaskView(task);
      const cb = botTaskAction(task, task.decision)?.callback;
      if (cb) {
        if (!(await this.profiles.readBot(sql, owner, task.botId)).callbackHosts.includes(new URL(cb.url).hostname))
          throw new BotError("callbackHostDenied", 403);
      }
      task.updatedAt = Date.now();
      await this.write(sql, task, null, null);
      await this.eventOn(sql, id, "manual", result.detail);
      return botTaskView(task);
    });
  }
  lifecycle(owner: string, id: string, action: "cancel" | "suspend" | "resume") {
    return this.context.transaction(async (sql) => {
      const current = await this.queries.readTask(sql, owner, id, true);
      const noOp =
        (action === "cancel" && current.status === "canceled") ||
        (action === "suspend" && current.status === "suspended") ||
        (action === "resume" && ["queued", "running"].includes(current.status));
      const next = transitionBotTask(current, action);
      if (noOp) return next;
      await this.write(sql, next, null, null);
      await this.eventOn(sql, id, action, next.status);
      return next;
    });
  }
  retention(owner: string) {
    return this.context.operation(async () => ({
      days: Number(
        (await this.pool`SELECT retentionDays FROM panda_force_bot_settings WHERE owner=${owner}`)[0]?.retentionDays ??
          5,
      ),
    }));
  }
  async setRetention(owner: string, days: unknown) {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365)
      throw new BotError("invalidInput");
    await this.context.operation(async () => {
      await this
        .pool`INSERT INTO panda_force_bot_settings(owner,retentionDays) VALUES(${owner},${days}) ON DUPLICATE KEY UPDATE retentionDays=VALUES(retentionDays)`;
    });
    return { days };
  }
  cleanup(now = Date.now(), limit = 100) {
    return this.context.transaction(async (sql) => {
      const rows = await sql.unsafe(
        "SELECT t.id FROM panda_force_bot_tasks t LEFT JOIN panda_force_bot_settings s ON s.owner=t.owner WHERE t.status IN ('kept','discarded','completed','canceled','callback_failed') AND t.updatedAt<? AND t.updatedAt < ? - COALESCE(s.retentionDays,5)*86400000 ORDER BY t.updatedAt,t.seq LIMIT ? FOR UPDATE",
        [now - 86400000, now, Math.min(Math.max(1, limit), 100)],
      );
      for (const row of rows) await this.tombstone(sql, row.id);
      return rows.length;
    });
  }
  hasSession = (...args: Parameters<MySQLBotProfiles["hasSession"]>) => this.profiles.hasSession(...args);
  prepareSession = (...args: Parameters<MySQLBotProfiles["prepareSession"]>) => this.profiles.prepareSession(...args);
  setSession = (...args: Parameters<MySQLBotProfiles["setSession"]>) => this.profiles.setSession(...args);
  close() {
    this.sessions.clear();
  }
}
