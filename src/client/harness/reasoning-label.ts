import type { MessageId, Translate } from "../../shared/i18n/messages.js";
const labels: Record<string, MessageId> = {
  default: "common.default",
  none: "common.none",
  minimal: "common.minimal",
  low: "common.low",
  medium: "common.medium",
  high: "common.high",
  xhigh: "common.extraHigh",
  max: "common.max",
  ultra: "common.ultra",
};
/** Known product levels are localized; optional provider metadata retains an explicit opaque fallback. */
export const reasoningMessage = (value: unknown) => (typeof value === "string" ? labels[value] : undefined);
export function reasoningLabel(value: unknown, t: Translate, fallback?: string) {
  const message = reasoningMessage(value);
  return message ? t(message) : fallback || (value ? String(value) : t("harness.automatic"));
}
