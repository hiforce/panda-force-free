import { SQL } from "bun";
import { BotError, type BotTask, type BotTaskSummary } from "../../shared/bots/contracts.js";
import { botTaskView } from "../../shared/bots/task-state.js";
import { defaultQueueQuery, queueStates, taskSummary, type BotQueueQuery } from "./queue-query.js";
import { MySQLBotContext } from "./mysql-context.js";
const parseTask = (data: string) => botTaskView(JSON.parse(data) as BotTask);
export class MySQLBotQueries {
  constructor(private readonly context: MySQLBotContext) {}
  tasks(owner: string) {
    return this.context.operation(async () =>
      (
        await this.context
          .pool`SELECT data FROM panda_force_bot_tasks WHERE owner=${owner} AND status!='deleted' ORDER BY seq DESC LIMIT 200`
      ).map((r: { data: string }) => parseTask(r.data)),
    );
  }
  async taskSummaries(owner: string) {
    return (await this.queue(owner, { ...defaultQueueQuery(), limit: 200 })).tasks;
  }
  queue(owner: string, query: BotQueueQuery = defaultQueueQuery()) {
    return this.context.operation(async () => {
      const newest = Number(
          (await this.context.pool`SELECT MAX(seq) n FROM panda_force_bot_tasks WHERE owner=${owner}`)[0].n ?? 0,
        ),
        anchor = query.anchor ? Math.min(query.anchor, newest) : newest;
      const where = ["owner=?", "status!='deleted'", "seq<=?"],
        values: (string | number)[] = [owner, anchor];
      if (query.botId) {
        where.push("botId=?");
        values.push(query.botId);
      }
      if (query.search) {
        const pattern = "%" + query.search.replace(/[!%_]/g, "!$&") + "%";
        where.push(
          "(externalTaskId LIKE ? ESCAPE '!' OR title LIKE ? ESCAPE '!' OR JSON_UNQUOTE(JSON_EXTRACT(data,'$.input.input.text')) LIKE ? ESCAPE '!')",
        );
        values.push(pattern, pattern, pattern);
      }
      const counts: Record<string, number> = {};
      for (const row of await this.context.pool.unsafe(
        `SELECT state,COUNT(*) n FROM panda_force_bot_tasks WHERE ${where.join(" AND ")} GROUP BY state`,
        values,
      ))
        counts[row.state] = Number(row.n);
      const states = queueStates(query.filter);
      if (states.length) {
        where.push(`state IN (${states.map(() => "?").join(",")})`);
        values.push(...states);
      }
      const total = (states.length ? states : Object.keys(counts)).reduce((n, k) => n + (counts[k] ?? 0), 0),
        page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
      const rows = await this.context.pool.unsafe(
        `SELECT id,botId,status,title,externalTaskId,COALESCE(actionId,decision) decision,failure,createdAt,updatedAt,summary,JSON_UNQUOTE(JSON_EXTRACT(data,'$.decisionLabel')) decisionLabel,JSON_UNQUOTE(JSON_EXTRACT(data,'$.callbackStatus')) callbackStatus,LEFT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data,'$.reason')),'null'),400) reason FROM panda_force_bot_tasks WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ? OFFSET ?`,
        [...values, query.limit, (page - 1) * query.limit],
      );
      return {
        tasks: rows.map((r: BotTaskSummary) =>
          taskSummary({ ...r, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) }),
        ),
        page,
        limit: query.limit,
        total,
        counts,
        anchor,
      };
    });
  }
  async readTask(sql: SQL, owner: string, id: string, lock = false) {
    const rows = await sql.unsafe(
      `SELECT data FROM panda_force_bot_tasks WHERE owner=? AND id=? AND status!='deleted'${lock ? " FOR UPDATE" : ""}`,
      [owner, id],
    );
    if (!rows.length) throw new BotError("notFound", 404);
    return parseTask(rows[0].data);
  }
  task(owner: string, id: string) {
    return this.context.operation(() => this.readTask(this.context.pool, owner, id));
  }
  events(owner: string, id: string) {
    return this.context.operation(async () => {
      await this.readTask(this.context.pool, owner, id);
      return (
        await this.context
          .pool`SELECT createdAt,kind,detail FROM panda_force_bot_events WHERE taskId=${id} ORDER BY seq`
      ).map((row: { createdAt: string | number; kind: string; detail: string }) => ({
        ...row,
        createdAt: Number(row.createdAt),
      }));
    });
  }
}
