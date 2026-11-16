import type { BotTaskSummary } from "../../shared/bots/contracts.js";
import { botTaskState, botCallbackStatus } from "../../shared/bots/task-state.js";

export function taskSummary(task: BotTaskSummary): BotTaskSummary {
  let summary = task.title || task.summary;
  if (!task.title && /^[{[]/.test(summary.trimStart())) {
    try {
      const value = JSON.parse(summary);
      summary = readableContent(value, 0) || summary;
      if (summary === task.summary)
        summary =
          Object.values(value)
            .filter((v): v is string => typeof v === "string" && !!v.trim())
            .join(" · ") || task.summary;
    } catch {
      /* Plain content remains a readable, bounded summary. */
    }
  }
  const { title, ...record } = task;
  return {
    ...record,
    ...(title ? { title } : {}),
    summary: summary.replace(/\s+/g, " ").slice(0, 240),
    state: botTaskState(task),
    callbackStatus: botCallbackStatus(task),
  };
}

function readableContent(value: unknown, depth: number): string | null {
  if (depth > 3 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) {
      const text = readableContent(item, depth + 1);
      if (text) return text;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["title", "name", "productName", "summary", "description", "text"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) return text;
  }
  for (const key of ["products", "items", "content", "data", "input", "records"]) {
    const text = readableContent(record[key], depth + 1);
    if (text) return text;
  }
  return null;
}
