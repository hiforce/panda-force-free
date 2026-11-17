import { isRecord } from "../records.js";
import type { ApplicationVisibleEvent } from "./application-tools.js";
import type { TokenCount, TokenUsage } from "./types.js";

export function visibleTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return;
  const counters = (value: unknown): TokenCount | undefined => {
    if (!isRecord(value)) return;
    const result: TokenCount = {};
    for (const key of [
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningOutputTokens",
    ] as const) {
      const count = value[key];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
    }
    return Object.keys(result).length ? result : undefined;
  };
  const result: TokenUsage = { total: counters(value.total), last: counters(value.last) };
  if (
    typeof value.modelContextWindow === "number" &&
    Number.isSafeInteger(value.modelContextWindow) &&
    value.modelContextWindow > 0
  )
    result.modelContextWindow = value.modelContextWindow;
  return result.total || result.last || result.modelContextWindow ? result : undefined;
}

/** The allowlist intentionally excludes reasoning, command arguments, paths and arbitrary transport metadata. */
export function applicationVisibleEvents(emit: (event: ApplicationVisibleEvent) => void) {
  const messages = new Map<string, string>();
  return (method: string, value: unknown) => {
    if (!isRecord(value)) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = visibleTokenUsage(value.tokenUsage);
      if (usage) emit({ kind: "usage", usage });
      return;
    }
    const item = isRecord(value.item) ? value.item : null;
    const id = method === "item/agentMessage/delta" ? value.itemId : item?.id;
    if (typeof id !== "string" || !id || id.length > 128 || (!messages.has(id) && messages.size >= 64)) return;
    if (method === "item/agentMessage/delta" && typeof value.delta === "string") {
      const text = ((messages.get(id) || "") + value.delta).slice(0, 65536);
      messages.set(id, text);
      emit({ kind: "message", id, text, complete: false });
    } else if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
      const text = item.text.slice(0, 65536);
      messages.set(id, text);
      emit({ kind: "message", id, text, complete: true });
    }
  };
}
