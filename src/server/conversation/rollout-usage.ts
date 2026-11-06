import { isRecord } from "../../shared/records.js";
import { tokenUsage } from "../../shared/engine/usage.js";

function breakdown(value: unknown) {
  if (!isRecord(value)) return;
  return {
    totalTokens: value.total_tokens,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cachedInputTokens: value.cached_input_tokens,
    reasoningOutputTokens: value.reasoning_output_tokens,
    cacheWriteInputTokens: value.cache_write_input_tokens,
  };
}

/** Translate persisted native counters at the journal boundary, without rescanning full history. */
export function rolloutTokenUsage(info: unknown, timestamp?: string) {
  if (!isRecord(info)) return;
  return tokenUsage({
    total: breakdown(info.total_token_usage),
    last: breakdown(info.last_token_usage),
    modelContextWindow: info.model_context_window,
    updatedAt: timestamp ? Date.parse(timestamp) : undefined,
  });
}
