import type { TokenUsage } from "../../shared/engine/types.js";
import type { DataView } from "../../shared/data-view.js";
import type { SessionUsageView } from "../contracts/session-workspace.js";

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read engine counters without treating missing data as zero or double-counting cached input. */
export function sessionUsageView(value?: DataView<TokenUsage>): SessionUsageView {
  const input = count(value?.total?.inputTokens);
  const output = count(value?.total?.outputTokens);
  const total = count(value?.total?.totalTokens) ?? (input !== null && output !== null ? input + output : null);
  const context = count(value?.last?.totalTokens);
  const reportedWindow = count(value?.modelContextWindow);
  const window = reportedWindow !== null && reportedWindow > 0 ? reportedWindow : null;
  const sum = input !== null && output !== null ? input + output : 0;
  return {
    input,
    output,
    total,
    cached: count(value?.total?.cachedInputTokens),
    context,
    window,
    contextPercent: context !== null && window !== null ? Math.min(100, (context / window) * 100) : null,
    inputPercent: sum > 0 && input !== null ? (input / sum) * 100 : null,
  };
}
