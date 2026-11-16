import { defaultQueueQuery, queueStates, taskStateExpression, taskSummary, type BotQueueQuery } from "./queue-query.js";
import { botTaskView } from "../../shared/bots/task-state.js";
import { Database } from "bun:sqlite";
import { BotError, type BotTask, type BotTaskSummary } from "../../shared/bots/contracts.js";

type Row = { data: string };
export class SQLiteBotQueries {
  constructor(private readonly db: Database) {}
  tasks(owner: string): BotTask[] {
    return this.db
      .query<Row, [string]>(
        "SELECT data FROM bot_tasks WHERE owner=? AND status!='deleted' ORDER BY rowid DESC LIMIT 200",
      )
      .all(owner)
      .map((r) => botTaskView(JSON.parse(r.data)));
  }
  taskSummaries(owner: string): BotTaskSummary[] {
    return this.queue(owner, { ...defaultQueueQuery(), limit: 200 }).tasks;
  }
  queue(owner: string, query: BotQueueQuery = defaultQueueQuery()) {
    const newest =
      this.db.query<{ seq: number | null }, [string]>("SELECT MAX(rowid) seq FROM bot_tasks WHERE owner=?").get(owner)
        ?.seq ?? 0;
    const anchor = query.anchor ? Math.min(query.anchor, newest) : newest;
    const conditions = ["owner=?", "status!='deleted'", "rowid<=?"],
      values: (string | number)[] = [owner, anchor];
    if (query.botId) {
      conditions.push("botId=?");
      values.push(query.botId);
    }
    if (query.search) {
      conditions.push(
        "(json_extract(data,'$.externalTaskId') LIKE ? ESCAPE '\\' OR json_extract(data,'$.input.input.text') LIKE ? ESCAPE '\\' OR json_extract(data,'$.title') LIKE ? ESCAPE '\\')",
      );
      const pattern = "%" + query.search.replace(/[\\%_]/g, "\\$&") + "%";
      values.push(pattern, pattern, pattern);
    }
    const counts: Record<string, number> = {};
    for (const row of this.db
      .query<{ state: string; n: number }, (string | number)[]>(
        `SELECT ${taskStateExpression} state,count(*) n FROM bot_tasks WHERE ${conditions.join(" AND ")} GROUP BY state`,
      )
      .all(...values))
      counts[row.state] = row.n;
    const states = queueStates(query.filter);
    if (states.length) {
      conditions.push(`(${taskStateExpression}) IN (${states.map(() => "?").join(",")})`);
      values.push(...states);
    }
    const total = states.length
      ? states.reduce((n, k) => n + (counts[k] ?? 0), 0)
      : Object.values(counts).reduce((a, b) => a + b, 0);
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
    const tasks = this.db
      .query<BotTaskSummary, (string | number)[]>(
        `SELECT id,botId,status,
      json_extract(data,'$.title') title,json_extract(data,'$.externalTaskId') externalTaskId,json_extract(data,'$.decision') decision,json_extract(data,'$.decisionLabel') decisionLabel,
      json_extract(data,'$.failure') failure,json_extract(data,'$.callbackStatus') callbackStatus,
      json_extract(data,'$.createdAt') createdAt,json_extract(data,'$.updatedAt') updatedAt,
      json_extract(data,'$.input.input.text') summary,NULL reason
      FROM bot_tasks WHERE ${conditions.join(" AND ")} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, (page - 1) * query.limit)
      .map(taskSummary);
    return { tasks, page, limit: query.limit, total, counts, anchor };
  }
  task(owner: string, id: string): BotTask {
    const r = this.db
      .query<Row, [string, string]>("SELECT data FROM bot_tasks WHERE owner=? AND id=? AND status!='deleted'")
      .get(owner, id);
    if (!r) throw new BotError("notFound", 404);
    return botTaskView(JSON.parse(r.data));
  }
  events(owner: string, id: string) {
    this.task(owner, id);
    return this.db
      .query<{ createdAt: number; kind: string; detail: string }, [string]>(
        "SELECT createdAt,kind,detail FROM bot_events WHERE taskId=? ORDER BY rowid",
      )
      .all(id);
  }
}
