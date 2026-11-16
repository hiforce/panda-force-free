import { BotError } from "../../shared/bots/contracts.js";
export { taskSummary } from "./task-title.js";

export interface BotQueueQuery {
  page: number;
  anchor: number;
  limit: number;
  filter: string;
  botId: string;
  search: string;
}
export function botQueueQuery(params: URLSearchParams): BotQueueQuery {
  const anchor = Number(params.get("anchor") ?? 0);
  const page = Number(params.get("page") ?? 1),
    limit = Number(params.get("limit") ?? 50);
  const filter = params.get("filter") ?? "",
    botId = params.get("bot") ?? "",
    search = (params.get("q") ?? "").trim();
  if (
    !Number.isSafeInteger(anchor) ||
    anchor < 0 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    ![25, 50, 100].includes(limit) ||
    search.length > 160 ||
    botId.length > 128 ||
    ![
      "",
      "attention",
      "progress",
      "completed",
      "created",
      "running",
      "finished",
      "suspended",
      "canceled",
      "error",
    ].includes(filter)
  )
    throw new BotError("invalidInput");
  return { page, anchor, limit, filter, botId, search };
}
export const defaultQueueQuery = (): BotQueueQuery => botQueueQuery(new URLSearchParams());
export const taskStateExpression = `CASE WHEN status='queued' THEN 'created' WHEN status='running' THEN 'running' WHEN status IN ('kept','discarded','completed') THEN 'finished' WHEN status='canceled' THEN 'canceled' WHEN status='callback_failed' OR (status='review' AND json_extract(data,'$.failure')='execution') THEN 'error' ELSE 'suspended' END`;
export function queueStates(filter: string): string[] {
  return filter === "attention"
    ? ["suspended", "error"]
    : filter === "progress"
      ? ["created", "running"]
      : filter === "completed"
        ? ["finished"]
        : filter
          ? [filter]
          : [];
}
