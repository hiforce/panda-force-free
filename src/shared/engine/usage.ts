import { isRecord } from "../records.js";
import type { TokenCount, TokenUsage } from "./types.js";

const fields = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
  "cacheWriteInputTokens",
] as const;
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function breakdown(value: unknown): TokenCount | undefined {
  if (!isRecord(value)) return;
  const result: TokenCount = {};
  for (const key of fields) if (counter(value[key])) result[key] = value[key];
  return Object.keys(result).length ? result : undefined;
}

/** Validate portable provider counters; missing values remain unknown rather than zero. */
export function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return;
  const total = breakdown(value.total),
    last = breakdown(value.last);
  const window = counter(value.modelContextWindow) ? value.modelContextWindow : undefined;
  if (!total && !last && window === undefined) return;
  return {
    ...(total ? { total } : {}),
    ...(last ? { last } : {}),
    ...(window === undefined ? {} : { modelContextWindow: window }),
    ...(counter(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  };
}

/** A late history read must not roll back a more recent live observation. */
export function latestTokenUsage(
  previous: TokenUsage | undefined,
  incoming: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (previous.updatedAt !== undefined && incoming.updatedAt !== undefined && previous.updatedAt !== incoming.updatedAt)
    return incoming.updatedAt > previous.updatedAt ? incoming : previous;
  const before = previous.total?.totalTokens,
    after = incoming.total?.totalTokens;
  if (before !== undefined && after !== undefined && before !== after) return after > before ? incoming : previous;
  if (previous.updatedAt !== undefined && incoming.updatedAt === undefined) return previous;
  return incoming;
}
